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
const OPTIONAL_DEPENDENCIES = Object.keys(require('../../../package.json').optionalDependencies)
// Installed in this repository, so they are bundled.
const BUNDLED_OPTIONAL_DEPENDENCIES = ['@opentelemetry/api', '@opentelemetry/api-logs']
const NATIVE_OPTIONAL_DEPENDENCIES = OPTIONAL_DEPENDENCIES.filter(name => !BUNDLED_OPTIONAL_DEPENDENCIES.includes(name))
const TRACER_DIRECTORY = `${fs.realpathSync(path.join(__dirname, '../../..')).replaceAll('\\', '/')}/`
const TRACER_MODULE = `${TRACER_DIRECTORY}packages/dd-trace/src/runtime_metrics/runtime_metrics.js`
const OTHER_TRACER_COPY_MODULE = '/app/node_modules/dd-trace/packages/dd-trace/src/runtime_metrics/runtime_metrics.js'
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
    it('refuses to bundle with Vite versions lacking the Environment API', () => {
      const plugin = datadogVite()

      assert.throws(() => plugin.configResolved.call(ROLLUP, { build: {}, esbuild: {} }), {
        message: 'dd-trace/vite requires Vite 6 or newer. Refusing to bundle.',
      })
      plugin.configResolved.call(ROLLUP, { build: {}, environments: {}, esbuild: {} })
    })

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
    it('externalizes optional dependencies imported by the tracer on Rolldown, bundling installed ones', () => {
      const external = configureEnvironment(ROLLDOWN, {}).build.rolldownOptions.external

      for (const name of NATIVE_OPTIONAL_DEPENDENCIES) {
        assert.equal(isExternal(external, name, TRACER_MODULE), true, name)
        assert.equal(isExternal(external, `${name}/subpath`, TRACER_MODULE), true, name)
        assert.equal(isExternal(external, name, OTHER_TRACER_COPY_MODULE), true, name)
        assert.equal(isExternal(external, name, OTHER_TRACER_COPY_MODULE.replaceAll('/', '\\')), true, name)
      }
      for (const name of BUNDLED_OPTIONAL_DEPENDENCIES) {
        assert.equal(isExternal(external, name, TRACER_MODULE), false, name)
      }
      for (const name of ['express', '@opentelemetry/api-extra', '@datadog/pprof-extra', 'my-oxc-parser']) {
        assert.equal(isExternal(external, name, TRACER_MODULE), false, name)
      }
    })

    it('bundles the application imports of optional dependencies on Rolldown', () => {
      const external = configureEnvironment(ROLLDOWN, {}).build.rolldownOptions.external

      for (const name of OPTIONAL_DEPENDENCIES) {
        assert.equal(isExternal(external, name), false, name)
        assert.equal(isExternal(external, name, '/app/node_modules/library/index.js'), false, name)
        assert.equal(external(name, undefined, false), false, name)
      }
    })

    it('keeps missing pure JavaScript optional dependencies out of the bundle with either bundler', () => {
      const missing = new Set(['@opentelemetry/api-logs'])
      const createRequire = sinon.spy(filename => {
        const tracerRequire = require('node:module').createRequire(filename)
        return {
          resolve (/** @type {string} */ name) {
            if (!missing.has(name)) return tracerRequire.resolve(name)
            throw Object.assign(new Error(`Cannot find module '${name}'`), { code: 'MODULE_NOT_FOUND' })
          },
        }
      })
      const { datadogVite } = proxyquire('../index', { 'node:module': { createRequire } })
      const configure = (context, config) => {
        datadogVite().configEnvironment.call(context, 'ssr', config)
        return config.build
      }

      const { external } = configure(ROLLDOWN, {}).rolldownOptions
      const { ignore } = configure(ROLLUP, {}).commonjsOptions

      assert.equal(isExternal(external, '@opentelemetry/api-logs', TRACER_MODULE), true)
      assert.equal(isExternal(external, '@opentelemetry/api', TRACER_MODULE), false)
      assert.equal(ignore('@opentelemetry/api-logs'), true)
      assert.equal(ignore('@opentelemetry/api'), false)
      sinon.assert.alwaysCalledWithExactly(createRequire, `${TRACER_DIRECTORY}index.js`)
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

        assert.equal(typeof external, 'function')
        assert.equal(isExternal(external, '@datadog/native-metrics', TRACER_MODULE), true)
        assert.equal(isExternal(external, '@datadog/native-metrics'), false)
        assert.equal(isExternal(external, 'express'), false)
        for (const id of userIds) assert.equal(isExternal(external, id), true, id)
      }
      sinon.assert.calledWithExactly(userFunction, 'electron', '/app/main.js', false)
      sinon.assert.neverCalledWith(userFunction, '@datadog/native-metrics', TRACER_MODULE)
    })

    it('reuses the aliased rollupOptions and stays idempotent across environments on Rolldown', () => {
      const rollupOptions = { external: ['electron'] }
      const plugin = datadogVite()

      plugin.configEnvironment.call(ROLLDOWN, 'ssr', { build: { rollupOptions } })
      const once = rollupOptions.external
      plugin.configEnvironment.call(ROLLDOWN, 'ssr', { build: { rollupOptions } })

      assert.strictEqual(rollupOptions.external, once)
      assert.equal(isExternal(once, 'electron'), true)

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

        for (const name of NATIVE_OPTIONAL_DEPENDENCIES) assert.equal(ignore(`${name}/subpath`), true, name)
        for (const name of BUNDLED_OPTIONAL_DEPENDENCIES) assert.equal(ignore(name), false, name)
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

  describe('CommonJS globals in ESM output', () => {
    it('defines require, __filename and __dirname in every Rollup ESM chunk', async () => {
      const plugin = datadogVite()

      for (const format of [undefined, 'es', 'esm', 'module']) {
        const output = { format, intro: 'const userIntro = true;' }
        const { intro } = plugin.outputOptions.call(ROLLUP, output)

        assert.equal(output.intro, 'const userIntro = true;')
        assert.match(intro, /^import .+\nconst userIntro = true;$/s, format)
      }

      // Bundles built in different directories resolve against their own installation, without process-wide globals.
      const names = ['require', '__filename', '__dirname']
      const globals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name))
      const { intro } = plugin.outputOptions.call(ROLLUP, {})
      for (const installation of ['first', 'second']) {
        const projectDir = createProject()
        write(createPackage(projectDir, '@datadog/native-metrics', { main: 'index.js' }), 'index.js',
          `module.exports = '${installation}'\n`)
        const chunk = fs.realpathSync(write(projectDir, 'dist/chunk.mjs',
          `${intro}export default [require('@datadog/native-metrics'), __filename, __dirname]\n`))

        const { default: bindings } = await import(pathToFileURL(chunk).href)
        assert.deepStrictEqual(bindings, [installation, chunk, path.dirname(chunk)])
      }
      assert.deepStrictEqual(names.map(name => Object.getOwnPropertyDescriptor(globalThis, name)), globals)
    })

    it('composes a user intro function', async () => {
      const userIntro = sinon.stub().resolves('const userIntro = true;')
      const { intro } = datadogVite().outputOptions.call(ROLLUP, { intro: userIntro })

      const code = await intro({ isEntry: true })
      assert.match(code, /^import \{ createRequire as \$dd_createRequire \} from 'node:module';\n.+\nconst userIntro = true;$/s)
      sinon.assert.calledOnceWithExactly(userIntro, { isEntry: true })
    })

    it('leaves CommonJS output and Rolldown untouched', () => {
      const plugin = datadogVite()

      assert.equal(plugin.outputOptions.call(ROLLUP, { format: 'cjs' }), undefined)
      assert.equal(plugin.outputOptions.call(ROLLDOWN, { format: 'es' }), undefined)
      assert.equal(plugin.outputOptions.call(ROLLDOWN, {}), undefined)
    })
  })

  describe('function and class names', () => {
    it('enables esbuild keepNames on Rollup when a built Node.js environment minifies with esbuild', () => {
      const client = { consumer: 'client', build: { minify: 'esbuild', ssr: false } }
      const ssr = (minify, extra) => ({ consumer: 'server', build: { minify, ssr: false, ...extra } })
      const keepsNames = (config, context) => {
        const resolved = { esbuild: { jsx: 'automatic' }, ...config, build: { ssr: false, ...config.build } }
        datadogVite().configResolved.call(context ?? ROLLUP, resolved)
        return resolved.esbuild && resolved.esbuild.keepNames
      }

      // Each environment resolves its own configuration, with its build options, unless the builder shares it.
      for (const builder of [undefined, { sharedConfigBuild: false }]) {
        const environments = { client, ssr: ssr('esbuild') }
        assert.equal(keepsNames({ builder, build: { minify: 'esbuild' }, environments }), undefined)
        assert.equal(keepsNames({ builder, build: { minify: 'esbuild', ssr: 'server.ts' }, environments }), true)
        assert.equal(keepsNames({ builder, build: { minify: 'esbuild', lib: {} }, environments }), true)
        assert.equal(keepsNames({ builder, build: { minify: false, ssr: true }, environments }), undefined)
        assert.equal(keepsNames({ builder, build: { minify: 'terser', ssr: true }, environments }), undefined)
      }
      // A shared configuration shares the esbuild options between every built environment.
      const shared = { sharedConfigBuild: true }
      assert.equal(keepsNames({ builder: shared, environments: { client, ssr: ssr(false) } }), undefined)
      assert.equal(keepsNames({ builder: shared, environments: { client, main: ssr('esbuild') } }), true)
      assert.equal(keepsNames({ builder: shared, environments: { client, main: ssr('terser') } }), undefined)

      const minifiedSsr = { build: { minify: 'esbuild', ssr: 'server.ts' }, environments: { ssr: ssr('esbuild') } }
      assert.equal(keepsNames({ ...minifiedSsr, esbuild: { keepNames: false } }), false)
      assert.equal(keepsNames({ ...minifiedSsr, esbuild: false }), false)
      assert.equal(keepsNames(minifiedSsr, ROLLDOWN), undefined)
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
    })

    it('filters the transform hook to target packages', () => {
      const { filter } = datadogVite().transform

      assert.equal(filter.id.test('/app/node_modules/express/lib/express.js'), true)
      assert.equal(filter.id.test('/app/node_modules/@langchain/langgraph/dist/index.js'), true)
      assert.equal(filter.id.test('/app/node_modules/unrelated/index.js'), false)
      assert.equal(filter.id.test('/app/src/server.ts'), false)
    })

    it('leaves loading the tracer to the application', () => {
      const plugin = datadogVite()

      assert.equal(plugin.resolveId, undefined)
      assert.equal(plugin.load, undefined)
      assert.equal(runTransform(plugin, 'export const value = 1\n', '/app/src/server.ts').result, undefined)
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

  describe('git metadata', () => {
    it('sets the git metadata banner once per entry chunk', () => {
      const banner = 'process.env.DD_GIT_COMMIT_SHA = "abc123";\n'
      const getGitMetadataBanner = sinon.stub().returns(banner)
      const plugin = loadPlugin({ getGitMetadataBanner }).datadogVite()

      assert.equal(plugin.intro({ isEntry: false }), '')
      assert.equal(plugin.intro({ isEntry: true }), banner)
      assert.equal(plugin.intro({ isEntry: true }), banner)
      sinon.assert.calledOnce(getGitMetadataBanner)
    })

    it('looks up missing git metadata only once', () => {
      const getGitMetadataBanner = sinon.stub().returns('')
      const plugin = loadPlugin({ getGitMetadataBanner }).datadogVite()

      assert.equal(plugin.intro({ isEntry: true }), '')
      assert.equal(plugin.intro({ isEntry: true }), '')
      sinon.assert.calledOnce(getGitMetadataBanner)
    })

    it('skips git metadata when DD_BUNDLER_INJECT_GIT_METADATA=false', () => {
      process.env.DD_BUNDLER_INJECT_GIT_METADATA = 'false'
      const getGitMetadataBanner = sinon.stub().returns('process.env.DD_GIT_COMMIT_SHA = "abc123";\n')
      const plugin = loadPlugin({ getGitMetadataBanner }).datadogVite()

      assert.equal(plugin.intro({ isEntry: true }), '')
      sinon.assert.notCalled(getGitMetadataBanner)
    })
  })
})

/**
 * @param {{ getGitMetadataBanner?: Function, instrument?: Function }} stubs
 * @returns {{ datadogVite: typeof datadogVite }}
 */
function loadPlugin ({ getGitMetadataBanner, instrument }) {
  const stubs = {}
  if (getGitMetadataBanner) {
    stubs['../datadog-instrumentations/src/helpers/bundler-utils'] = { getGitMetadataBanner }
  }
  if (instrument) stubs['../datadog-instrumentations/src/helpers/bundler-transform'] = { instrument }
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
 * @param {string | undefined} [parentId]
 */
function isExternal (external, id, parentId = '/app/main.js') {
  if (typeof external === 'function') return Boolean(external(id, parentId, false))
  return [external].flat().some(entry => typeof entry === 'string' ? entry === id : entry.test(id))
}

/**
 * @param {object} plugin
 * @param {string} code
 * @param {string} id
 */
function runTransform (plugin, code, id) {
  const warn = sinon.spy()
  const context = { warn }
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
