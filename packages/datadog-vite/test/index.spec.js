'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const vm = require('node:vm')

const dc = require('dc-polyfill')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const { datadogVite } = require('../../../vite')

const ROLLDOWN = { meta: { rolldownVersion: '1.0.0', viteVersion: '8.0.0' } }
const ROLLUP = { meta: { rollupVersion: '4.0.0', viteVersion: '7.0.0' } }
const FIRST_IMPORT = 'import "virtual:dd-trace-vite/init";'
const OPTIONAL_DEPENDENCIES = Object.keys(require('../../../package.json').optionalDependencies)
const directories = []

describe('datadogVite', () => {
  const originalInjectGitMetadata = process.env.DD_BUNDLER_INJECT_GIT_METADATA

  afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { force: true, recursive: true })
    if (originalInjectGitMetadata === undefined) {
      delete process.env.DD_BUNDLER_INJECT_GIT_METADATA
    } else {
      process.env.DD_BUNDLER_INJECT_GIT_METADATA = originalInjectGitMetadata
    }
    sinon.restore()
  })

  it('exports a build-time pre plugin to CommonJS and ESM configurations', async () => {
    const namespace = await import(pathToFileURL(require.resolve('../../../vite')).href)
    const plugin = datadogVite()

    assert.strictEqual(namespace.datadogVite, datadogVite)
    assert.equal(plugin.name, 'datadog-vite')
    assert.equal(plugin.apply, 'build')
    assert.equal(plugin.enforce, 'pre')
  })

  describe('environment gating', () => {
    it('applies to server, SSR and library environments only', () => {
      const plugin = datadogVite()
      const applies = (name, consumer, build) => plugin.applyToEnvironment({ name, config: { build, consumer } })

      assert.equal(applies('ssr', 'server', { ssr: false }), true)
      assert.equal(applies('client', 'client', { ssr: true }), true)
      assert.equal(applies('client', 'client', { ssr: 'src/main.ts' }), true)
      assert.equal(applies('client', 'client', { lib: { entry: 'src/main.ts' }, ssr: false }), true)
      assert.equal(applies('client', 'client', { ssr: false }), false)
      // Electron Forge preload: a CommonJS client build with an explicit input.
      assert.equal(applies('client', 'client', { rollupOptions: { input: 'src/preload.ts' }, ssr: false }), false)
    })

    it('configures server, SSR and library environments only', () => {
      const plugin = datadogVite()
      const configure = (name, config) => {
        plugin.configEnvironment.call(ROLLUP, name, config)
        return config
      }

      assert.equal(typeof configure('ssr', {}).build.commonjsOptions.ignore, 'function')
      assert.equal(typeof configure('client', { build: { ssr: true } }).build.commonjsOptions.ignore, 'function')
      assert.equal(typeof configure('client', { build: { lib: {} } }).build.commonjsOptions.ignore, 'function')
      assert.equal(typeof configure('worker', { consumer: 'client', build: { lib: {} } }).build.commonjsOptions.ignore,
        'function')
      assert.deepStrictEqual(configure('client', {}), {})
      assert.deepStrictEqual(configure('preload', { consumer: 'client', build: {} }), { consumer: 'client', build: {} })
    })
  })

  describe('optional tracer dependencies', () => {
    it('externalizes every optional dependency and its subpaths on Rolldown', () => {
      const external = configureEnvironment(ROLLDOWN, {}).build.rolldownOptions.external

      for (const name of OPTIONAL_DEPENDENCIES) {
        assert.equal(isExternal(external, name), true, name)
        assert.equal(isExternal(external, `${name}/subpath`), true, name)
      }
      for (const name of ['express', '@opentelemetry/api-extra', '@datadog/pprof-extra', 'my-oxc-parser']) {
        assert.equal(isExternal(external, name), false, name)
      }
    })

    it('merges every external shape on Rolldown', () => {
      const userFunction = sinon.spy((/** @type {string} */ id, ...rest) => id === 'electron')
      /** @type {Array<[unknown, string[]]>} */
      const shapes = [
        ['electron', ['electron']],
        [/^electron$/, ['electron']],
        [['electron', /^node:/], ['electron', 'node:fs']],
        [userFunction, ['electron']],
        // Vite concatenates arrays while merging configurations, even when one side is a function.
        [[userFunction, 'node:fs'], ['electron', 'node:fs']],
      ]

      for (const [userExternal, userIds] of shapes) {
        const external = configureEnvironment(ROLLDOWN, { build: { rolldownOptions: { external: userExternal } } })
          .build.rolldownOptions.external

        assert.ok(typeof external === 'function' || external.every(entry => typeof entry !== 'function'))
        assert.equal(isExternal(external, '@datadog/native-metrics'), true)
        assert.equal(isExternal(external, 'express'), false)
        for (const id of userIds) assert.equal(isExternal(external, id), true, id)
      }
      sinon.assert.calledWithExactly(userFunction, 'electron', '/app/main.js', false)
      sinon.assert.neverCalledWith(userFunction, '@datadog/native-metrics')
    })

    it('reuses the aliased rollupOptions and stays idempotent across environments on Rolldown', () => {
      const rollupOptions = { external: ['electron'] }
      const plugin = datadogVite()

      plugin.configEnvironment.call(ROLLDOWN, 'ssr', { build: { rollupOptions } })
      const once = rollupOptions.external
      plugin.configEnvironment.call(ROLLDOWN, 'ssr', { build: { rollupOptions } })

      assert.strictEqual(rollupOptions.external, once)
      assert.equal(once.length, 2)

      const userFunction = () => false
      const functionOptions = { external: userFunction }
      plugin.configEnvironment.call(ROLLDOWN, 'ssr', { build: { rolldownOptions: functionOptions } })
      const wrapped = functionOptions.external
      plugin.configEnvironment.call(ROLLDOWN, 'ssr', { build: { rolldownOptions: functionOptions } })

      assert.notStrictEqual(wrapped, userFunction)
      assert.strictEqual(functionOptions.external, wrapped)
    })

    it('keeps optional dependency requires in place on Rollup, merging every ignore shape', () => {
      const userFunction = sinon.spy(id => id === 'user-ignored')
      const shapes = [undefined, ['user-ignored'], userFunction]

      for (const userIgnore of shapes) {
        const { build } = configureEnvironment(ROLLUP, { build: { commonjsOptions: { ignore: userIgnore } } })
        const { ignore } = build.commonjsOptions

        for (const name of OPTIONAL_DEPENDENCIES) assert.equal(ignore(`${name}/subpath`), true, name)
        assert.equal(ignore('express'), false)
        assert.equal(ignore('user-ignored'), userIgnore !== undefined)
        assert.equal(build.rollupOptions, undefined)
        assert.equal(build.rolldownOptions, undefined)
      }
      sinon.assert.neverCalledWith(userFunction, '@datadog/native-metrics/subpath')

      const commonjsOptions = {}
      const plugin = datadogVite()
      plugin.configEnvironment.call(undefined, 'ssr', { build: { commonjsOptions } })
      const once = commonjsOptions.ignore
      plugin.configEnvironment.call(undefined, 'ssr', { build: { commonjsOptions } })
      assert.strictEqual(commonjsOptions.ignore, once)
    })
  })

  describe('function and class names', () => {
    it('enables esbuild keepNames on Rollup whenever an environment may minify with esbuild', () => {
      const keepsNames = (config, env) => {
        datadogVite().config.call(undefined, config, env)
        return config.esbuild?.keepNames
      }

      assert.equal(keepsNames({ build: { lib: {} } }), true)
      assert.equal(keepsNames({ build: { minify: true, ssr: true } }), true)
      assert.equal(keepsNames({ build: { minify: 'esbuild' }, esbuild: { jsx: 'automatic' } }), true)
      assert.equal(keepsNames({ build: { ssr: true }, environments: { main: { build: { minify: 'esbuild' } } } }), true)
      assert.equal(keepsNames({ build: { ssr: 'src/server.ts' } }), undefined)
      assert.equal(keepsNames({ build: { ssr: true }, environments: { main: { build: { minify: 'terser' } } } }),
        undefined)
      assert.equal(keepsNames({}, { isSsrBuild: true }), undefined)
      assert.equal(keepsNames({ build: { minify: false } }), undefined)
      assert.equal(keepsNames({ build: { minify: 'terser' } }), undefined)
      assert.equal(keepsNames({ esbuild: { keepNames: false } }), false)
      assert.equal(keepsNames({ esbuild: false }), undefined)

      const config = { build: { minify: true }, esbuild: { jsx: 'automatic' } }
      datadogVite().config.call(ROLLDOWN, config)
      assert.deepStrictEqual(config.esbuild, { jsx: 'automatic' })
    })

    it('enables output keepNames on Rolldown for minified environments', () => {
      const keepsNames = (name, build) => {
        const { output } = configureEnvironment(ROLLDOWN, { build }, name).build.rolldownOptions
        return Array.isArray(output) ? output.map(entry => entry.keepNames) : output?.keepNames
      }

      assert.equal(keepsNames('client', { lib: {} }), true)
      assert.equal(keepsNames('ssr', { minify: true }), true)
      assert.equal(keepsNames('ssr', { minify: 'oxc' }), true)
      assert.equal(keepsNames('ssr', { minify: 'esbuild' }), true)
      assert.equal(keepsNames('ssr', { minify: 'terser' }), true)
      assert.equal(keepsNames('ssr', {}), undefined)
      assert.equal(keepsNames('client', { lib: {}, minify: false }), undefined)
      assert.equal(keepsNames('client', { lib: {}, minify: 'false' }), undefined)
      assert.equal(keepsNames('ssr', { minify: true, rolldownOptions: { output: { keepNames: false } } }), false)
      assert.deepStrictEqual(
        keepsNames('ssr', { minify: true, rolldownOptions: { output: [{ format: 'cjs' }, { keepNames: false }] } }),
        [true, false]
      )
    })

    it('enables terser keep_classnames and keep_fnames with either bundler', () => {
      for (const context of [ROLLUP, ROLLDOWN]) {
        const { build } = configureEnvironment(context, { build: { minify: 'terser', terserOptions: { ecma: 2020 } } })
        assert.deepStrictEqual(build.terserOptions, { ecma: 2020, keep_classnames: true, keep_fnames: true })

        const configured = configureEnvironment(context, {
          build: { minify: 'terser', terserOptions: { keep_fnames: false } },
        }).build.terserOptions
        assert.deepStrictEqual(configured, { keep_classnames: true, keep_fnames: false })

        assert.equal(configureEnvironment(context, { build: { minify: 'esbuild' } }).build.terserOptions, undefined)
      }
    })
  })

  describe('transform', () => {
    it('publishes the CommonJS exports of target packages', () => {
      const projectDir = createProject()
      const packageDir = createPackage(projectDir, 'express', { main: 'index.js', version: '4.22.1' })
      const source = 'module.exports = function createApplication () { return "app" }\n'
      const resourcePath = write(packageDir, 'lib/express.js', source)
      const { result, warn } = runTransform(datadogVite(), source, resourcePath)

      const payloads = []
      const exports = executeCommonJs(result.code, payload => {
        payloads.push({ ...payload })
        payload.module = () => 'instrumented'
      })

      assert.equal(result.map, null)
      assert.equal(payloads.length, 1)
      assert.equal(typeof payloads[0].module, 'function')
      assert.deepStrictEqual({ ...payloads[0], module: undefined }, {
        module: undefined,
        package: 'express',
        path: 'express/lib/express.js',
        version: '4.22.1',
      })
      assert.equal(/** @type {Function} */ (exports)(), 'instrumented')
      sinon.assert.notCalled(warn)
    })

    it('leaves non-target, query, virtual and tracer modules untouched', () => {
      const projectDir = createProject()
      const packageDir = createPackage(projectDir, 'express', { main: 'index.js', version: '4.22.1' })
      const unrelatedDir = createPackage(projectDir, 'unrelated', { main: 'index.js', version: '1.0.0' })
      const source = 'module.exports = {}\n'
      const resourcePath = write(packageDir, 'lib/express.js', source)
      const unrelatedPath = write(unrelatedDir, 'index.js', source)
      const applicationPath = write(projectDir, 'src/express/index.js', source)
      const tracerDependency = path.join(fs.realpathSync(path.join(__dirname, '../../..')),
        'node_modules/express/lib/express.js')
      const instrument = sinon.spy()
      const plugin = loadPlugin({ instrument }).datadogVite()

      for (const id of [
        unrelatedPath,
        applicationPath,
        `${resourcePath}?commonjs-module`,
        `${resourcePath}?commonjs-es-import`,
        `\0${resourcePath}`,
        '\0dd-trace-vite:init',
        tracerDependency,
      ]) {
        const { result, warn } = runTransform(plugin, source, id)
        assert.equal(result, undefined, id)
        sinon.assert.notCalled(warn)
      }
      sinon.assert.notCalled(instrument)
    })

    it('fails open with a warning for unsafe CommonJS bindings and helper failures', () => {
      const projectDir = createProject()
      const packageDir = createPackage(projectDir, 'express', { main: 'index.js', version: '4.22.1' })
      const source = 'var module = { exports: {} }\n'
      const resourcePath = write(packageDir, 'lib/express.js', source)

      const unsafe = runTransform(datadogVite(), source, resourcePath)
      assert.equal(unsafe.result, undefined)
      sinon.assert.calledOnceWithExactly(unsafe.warn, sinon.match(/unsafe wrapper bindings/))

      const failing = loadPlugin({ instrument: () => { throw new Error('helper failed') } }).datadogVite()
      const failed = runTransform(failing, source, resourcePath)
      assert.equal(failed.result, undefined)
      sinon.assert.calledOnceWithExactly(failed.warn, sinon.match(/helper failed/))

      const throwing = loadPlugin({ instrument: () => { throw new Error('helper failed') } }).datadogVite()
      const entry = runTransform(throwing, source, resourcePath, { isEntry: true })
      assert.equal(entry.result, undefined)
    })

    it('passes the instrumentation source map through', () => {
      const projectDir = createProject()
      const packageDir = createPackage(projectDir, 'express', { main: 'index.js', version: '4.22.1' })
      const resourcePath = write(packageDir, 'lib/express.js', 'module.exports = {}\n')
      const map = { mappings: 'AAAA', version: 3 }
      const instrument = sinon.stub().callsFake(({ warn }) => {
        warn(new Error('rewriter warning'))
        return { code: 'module.exports = { rewritten: true }\n', map }
      })
      const plugin = loadPlugin({ instrument }).datadogVite()

      const { result, warn } = runTransform(plugin, 'module.exports = {}\n', resourcePath)

      assert.deepStrictEqual(result, { code: 'module.exports = { rewritten: true }\n', map })
      sinon.assert.calledOnceWithExactly(warn, 'rewriter warning')
      sinon.assert.calledOnceWithMatch(instrument, { resourcePath, source: 'module.exports = {}\n' })
    })
  })

  describe('Orchestrion', () => {
    it('rewrites and activates CommonJS and ESM targets without export hooks', async () => {
      for (const esm of [false, true]) {
        const { exports, payloads, result, starts } = await runRewrite({
          esm,
          name: 'bullmq',
          version: '5.66.0',
          file: `dist/${esm ? 'esm' : 'cjs'}/classes/queue.js`,
          source: esm
            ? 'export class Queue { async add () { return "added" } }\n'
            : 'class Queue { async add () { return "added" } }\nmodule.exports = { Queue }\n',
          channel: 'tracing:orchestrion:bullmq:Queue_add:start',
          run: exports => new exports.Queue().add(),
        })

        assert.equal(exports, 'added')
        assert.equal(starts, 1)
        assert.ok(result.map)
        assert.deepStrictEqual(payloads, [{
          activate: true,
          package: 'bullmq',
          path: `bullmq/dist/${esm ? 'esm' : 'cjs'}/classes/queue.js`,
          version: '5.66.0',
        }])
      }
    })

    it('rewrites targets with export hooks, activating ESM and publishing CommonJS exports', async () => {
      for (const esm of [false, true]) {
        const file = esm ? 'dist/index.mjs' : 'dist/index.js'
        const { exports, payloads, starts } = await runRewrite({
          esm,
          name: 'ai',
          version: '6.0.0',
          file,
          main: 'dist/index.js',
          source: esm
            ? 'export function getTracer () { return "tracer" }\n'
            : 'function getTracer () { return "tracer" }\nmodule.exports = { getTracer }\n',
          channel: 'tracing:orchestrion:ai:getTracer:start',
          run: exports => exports.getTracer(),
        })

        assert.equal(exports, 'tracer')
        assert.equal(starts, 1)
        assert.deepStrictEqual(payloads, esm
          ? [{ activate: true, package: 'ai', path: 'ai/dist/index.mjs', version: '6.0.0' }]
          : [{ hasModule: true, package: 'ai', path: 'ai', version: '6.0.0' }])
      }
    })

    it('rewrites targets without activation or export hooks', async () => {
      for (const esm of [false, true]) {
        const { exports, payloads, result, source, starts } = await runRewrite({
          esm,
          name: 'webdriver',
          version: '9.0.0',
          file: 'build/index.js',
          source: esm
            ? 'export function initiateBidi () { return "bidi" }\n'
            : 'function initiateBidi () { return "bidi" }\nmodule.exports = { initiateBidi }\n',
          channel: 'tracing:orchestrion:webdriver:initiateBidi:start',
          run: exports => exports.initiateBidi(),
        })

        assert.notEqual(result.code, source)
        assert.equal(exports, 'bidi')
        assert.equal(starts, 1)
        assert.deepStrictEqual(payloads, [])
      }
    })

    it('leaves targets outside the supported version range untouched', async () => {
      const { payloads, result, starts } = await runRewrite({
        esm: false,
        name: 'bullmq',
        version: '5.65.0',
        file: 'dist/cjs/classes/queue.js',
        source: 'class Queue { async add () { return "added" } }\nmodule.exports = { Queue }\n',
        channel: 'tracing:orchestrion:bullmq:Queue_add:start',
        run: exports => new exports.Queue().add(),
      })

      assert.equal(result, undefined)
      assert.equal(starts, 0)
      assert.deepStrictEqual(payloads, [])
    })
  })

  describe('first import', () => {
    it('resolves the virtual module to the tracer package', () => {
      for (const name of ['dd-trace', 'dd-trace-electron']) {
        const { resolveId, load } = loadPlugin({ name }).datadogVite()

        assert.equal(resolveId.filter.id.test('virtual:dd-trace-vite/init'), true)
        assert.equal(resolveId.handler('virtual:dd-trace-vite/init'), '\0dd-trace-vite:init')
        assert.equal(resolveId.handler('virtual:other'), undefined)
        assert.equal(load.filter.id.test('\0dd-trace-vite:init'), true)
        assert.equal(load.handler('\0dd-trace-vite:init'), `import ${JSON.stringify(name)}\n`)
        assert.equal(load.handler('/app/src/main.js'), undefined)
      }
    })

    it('prepends the virtual import to every entry module, keeping a hashbang first', () => {
      const plugin = datadogVite()
      const entry = id => runTransform(plugin, 'export const value = 1\n', id, { isEntry: true }).result

      assert.deepStrictEqual(entry('/app/src/server.ts'), {
        code: `${FIRST_IMPORT}export const value = 1\n`,
        map: null,
      })
      assert.equal(entry('\0virtual:framework/server-entry').code, `${FIRST_IMPORT}export const value = 1\n`)
      assert.equal(entry('/app/node_modules/unrelated/server.js').code, `${FIRST_IMPORT}export const value = 1\n`)
      assert.equal(
        runTransform(plugin, '#!/usr/bin/env node\nmain()\n', '/app/cli.js', { isEntry: true }).result.code,
        `#!/usr/bin/env node\n${FIRST_IMPORT}main()\n`
      )
      assert.equal(
        runTransform(plugin, '#!/usr/bin/env node', '/app/cli.js', { isEntry: true }).result.code,
        `#!/usr/bin/env node\n${FIRST_IMPORT}`
      )
      assert.equal(runTransform(plugin, 'export const value = 1\n', '/app/src/other.ts').result, undefined)
      assert.equal(runTransform(plugin, 'import "dd-trace"\n', '\0dd-trace-vite:init', { isEntry: true }).result,
        undefined)
    })

    it('instruments a target entry module before prepending the virtual import', () => {
      const projectDir = createProject()
      const packageDir = createPackage(projectDir, 'express', { main: 'index.js', version: '4.22.1' })
      const source = 'module.exports = {}\n'
      const resourcePath = write(packageDir, 'lib/express.js', source)

      const { result } = runTransform(datadogVite(), source, resourcePath, { isEntry: true })

      assert.equal(result.code.slice(0, FIRST_IMPORT.length + source.length), FIRST_IMPORT + source)
      assert.match(result.code, /dd-trace:bundler:load/)
    })
  })

  describe('git metadata', () => {
    it('sets the repository URL and commit SHA once per entry chunk', () => {
      const getGitMetadata = sinon.stub().returns({
        commitSHA: 'abc123',
        repositoryURL: 'https://github.com/org/"repo".git',
      })
      const plugin = loadPlugin({ getGitMetadata }).datadogVite()

      const intro = plugin.intro({ isEntry: true })
      const env = {}
      vm.runInNewContext(intro, { process: { env } })

      assert.equal(plugin.intro({ isEntry: false }), '')
      assert.equal(plugin.intro({ isEntry: true }), intro)
      assert.deepStrictEqual(env, {
        DD_GIT_COMMIT_SHA: 'abc123',
        DD_GIT_REPOSITORY_URL: 'https://github.com/org/"repo".git',
      })
      vm.runInNewContext(intro, { process: undefined })
      sinon.assert.calledOnce(getGitMetadata)
    })

    it('sets only the available git metadata', () => {
      const getGitMetadata = sinon.stub()
      getGitMetadata.onFirstCall().returns({ commitSHA: 'abc123', repositoryURL: null })
      getGitMetadata.onSecondCall().returns({ commitSHA: null, repositoryURL: null })
      const { datadogVite } = loadPlugin({ getGitMetadata })

      const env = {}
      vm.runInNewContext(datadogVite().intro({ isEntry: true }), { process: { env } })

      assert.deepStrictEqual(env, { DD_GIT_COMMIT_SHA: 'abc123' })
      assert.equal(datadogVite().intro({ isEntry: true }), '')
    })

    it('skips git metadata when DD_BUNDLER_INJECT_GIT_METADATA=false', () => {
      process.env.DD_BUNDLER_INJECT_GIT_METADATA = 'false'
      const getGitMetadata = sinon.stub().returns({ commitSHA: 'abc123', repositoryURL: null })
      const plugin = loadPlugin({ getGitMetadata }).datadogVite()

      assert.equal(plugin.intro({ isEntry: true }), '')
      sinon.assert.notCalled(getGitMetadata)
    })
  })
})

/**
 * @param {{ getGitMetadata?: Function, instrument?: Function, name?: string }} stubs
 * @returns {{ datadogVite: typeof datadogVite }}
 */
function loadPlugin ({ getGitMetadata, instrument, name }) {
  const stubs = {}
  if (getGitMetadata) stubs['../datadog-instrumentations/src/helpers/bundler-git-metadata'] = { getGitMetadata }
  if (instrument) stubs['../datadog-instrumentations/src/helpers/bundler-transform'] = { instrument }
  if (name) stubs['../../package.json'] = { name }
  return proxyquire('../index', stubs)
}

/**
 * @param {object} context
 * @param {object} config
 * @param {string} [name]
 */
function configureEnvironment (context, config, name = 'ssr') {
  datadogVite().configEnvironment.call(context, name, config)
  return config
}

/**
 * Mirrors how Rollup and Rolldown match an `external` option against an import.
 *
 * @param {string | RegExp | Array<string | RegExp> | Function} external
 * @param {string} id
 */
function isExternal (external, id) {
  if (typeof external === 'function') return Boolean(external(id, '/app/main.js', false))
  return [external].flat().some(entry => typeof entry === 'string' ? entry === id : entry.test(id))
}

/**
 * @param {object} plugin
 * @param {string} code
 * @param {string} id
 * @param {{ isEntry?: boolean }} [moduleInfo]
 */
function runTransform (plugin, code, id, { isEntry = false } = {}) {
  const warn = sinon.spy()
  const context = { getModuleInfo: () => ({ isEntry }), warn }
  return { result: plugin.transform.handler.call(context, code, id), warn }
}

/**
 * @param {{
 *   channel: string,
 *   esm: boolean,
 *   file: string,
 *   main?: string,
 *   name: string,
 *   run: (exports: object) => unknown,
 *   source: string,
 *   version: string
 * }} options
 */
async function runRewrite ({ channel, esm, file, main, name, run, source, version }) {
  const projectDir = createProject()
  const packageDir = createPackage(projectDir, name, { main, type: esm ? 'module' : 'commonjs', version })
  const resourcePath = write(packageDir, file, source)
  const { result, warn } = runTransform(datadogVite(), source, resourcePath)
  sinon.assert.notCalled(warn)

  const outputPath = write(path.dirname(resourcePath), esm ? 'output.mjs' : 'output.cjs', result?.code ?? source)
  const payloads = []
  const onLoad = payload => {
    const { module, ...rest } = payload
    payloads.push(module ? { hasModule: true, ...rest } : rest)
  }
  let starts = 0
  const onStart = () => { starts++ }
  dc.channel('dd-trace:bundler:load').subscribe(onLoad)
  dc.channel(channel).subscribe(onStart)
  try {
    const exports = esm ? await import(pathToFileURL(outputPath).href) : require(outputPath)
    return { exports: await run(exports), payloads, result, source, starts }
  } finally {
    dc.channel('dd-trace:bundler:load').unsubscribe(onLoad)
    dc.channel(channel).unsubscribe(onStart)
  }
}

/**
 * @param {string} code
 * @param {(payload: { module: unknown, package: string, path: string, version: string }) => void} publish
 */
function executeCommonJs (code, publish) {
  const module = { exports: {} }
  const require = request => {
    assert.equal(request.startsWith('.'), true)
    return {
      channel: name => {
        assert.equal(name, 'dd-trace:bundler:load')
        return { hasSubscribers: true, publish }
      },
    }
  }
  const wrapper = vm.runInNewContext(`(function (exports, require, module) {${code}\n})`, {})
  wrapper(module.exports, require, module)
  return module.exports
}

function createProject () {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-vite-'))
  directories.push(projectDir)
  return projectDir
}

/**
 * @param {string} projectDir
 * @param {string} name
 * @param {object} packageJson
 */
function createPackage (projectDir, name, packageJson) {
  const packageDir = path.join(projectDir, 'node_modules', name)
  fs.mkdirSync(packageDir, { recursive: true })
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name, ...packageJson }))
  return packageDir
}

/**
 * @param {string} directory
 * @param {string} file
 * @param {string} source
 */
function write (directory, file, source) {
  const target = path.join(directory, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, source)
  return target
}
