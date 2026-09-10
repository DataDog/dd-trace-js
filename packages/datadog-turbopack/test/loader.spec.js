'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const vm = require('node:vm')

const sinon = require('sinon')

const loaderPath = require.resolve('../src/loader')
const directories = []

describe('Turbopack loader', () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { force: true, recursive: true })
    sinon.restore()
  })

  it('publishes every matching CommonJS package-root and file hook', () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'test-package', {
      main: 'index.js',
      version: '1.2.3',
    }, true)
    const source = [
      'const arguments = true',
      'const local = arguments => arguments[0]',
      'arguments: { break arguments }',
      'try { throw true } catch (arguments) {}',
      'class Example { arguments () {} }',
      'module.exports = { original: local([true]) }',
      '',
    ].join('\n')
    const resourcePath = write(packageDir, 'index.js', source)
    const internalPath = write(packageDir, 'internal.js', 'module.exports = { internal: true }\n')
    const targetHook = sinon.stub().callsFake(() => {
      instrumentations['test-package'] = [
        { hook: sinon.stub(), versions: ['>=1'] },
        { file: 'index.js', hook: sinon.stub(), versions: ['>=1'] },
      ]
    })
    const otherHook = sinon.stub()
    const instrumentations = {}
    const { loader, rewriteFactory } = loadLoader({
      hooks: { 'other-package': otherHook, 'test-package': targetHook },
      instrumentations,
    })
    const sourceMap = { mappings: 'AAAA', version: 3 }

    const result = runLoader(loader, resourcePath, fs.readFileSync(resourcePath, 'utf8'), sourceMap)
    const paths = []
    const exports = executeCommonJs(result.code, (payload) => {
      paths.push(payload.path)
      payload.module = { ...payload.module, [payload.path]: true }
    })
    const internal = runLoader(loader, internalPath, fs.readFileSync(internalPath, 'utf8'), sourceMap)

    assert.deepStrictEqual(paths, ['test-package', 'test-package/index.js'])
    assert.deepStrictEqual(exports, {
      original: true,
      'test-package': true,
      'test-package/index.js': true,
    })
    assert.strictEqual(result.sourceMap, sourceMap)
    assert.equal(internal.code, 'module.exports = { internal: true }\n')
    const inactivePublish = sinon.spy()
    const inactiveExports = executeCommonJs(result.code, inactivePublish, false)
    assert.equal(inactiveExports.original, true)
    assert.deepStrictEqual(Object.keys(inactiveExports), ['original'])
    sinon.assert.notCalled(inactivePublish)
    sinon.assert.calledOnceWithExactly(targetHook)
    sinon.assert.notCalled(otherHook)
    sinon.assert.notCalled(rewriteFactory)
  })

  it('publishes CommonJS targets only after fallthrough', () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'fallthrough-package', {
      main: 'index.js',
      version: '1.0.0',
    })
    const source = [
      "'use strict'",
      'function local (require, module) { return [require, module] }',
      'function localArgs () { return arguments[0] }',
      'const metadata = { arguments: true }',
      'local(() => {}, {})',
      'localArgs(true)',
      'metadata.arguments',
      'try {',
      "  module.exports = { original: 'value' }",
      '  if (globalThis.DD_TEST_EXIT_EARLY) {',
      '    module.exports.returned = true',
      '    return',
      '  }',
      '} finally {',
      '  module.exports.finalized = true',
      '}',
      '',
    ].join('\n')
    const resourcePath = write(packageDir, 'index.js', source)
    const instrumentations = {}
    const hook = sinon.stub().callsFake(() => {
      instrumentations['fallthrough-package'] = [{ hook: sinon.stub(), versions: ['1'] }]
    })
    const { loader } = loadLoader({ hooks: { 'fallthrough-package': hook }, instrumentations })
    const result = runLoader(loader, resourcePath, source)
    const publications = []
    const publish = payload => {
      publications.push(payload)
      payload.module = { patched: true }
    }

    const inactive = executeCommonJs(result.code, publish, false)
    const active = executeCommonJs(result.code, publish)
    const returned = executeCommonJs(result.code, publish, true, { DD_TEST_EXIT_EARLY: true })

    assert.equal(inactive.original, 'value')
    assert.equal(inactive.finalized, true)
    assert.equal(inactive.patched, undefined)
    assert.equal(active.patched, true)
    assert.equal(returned.original, 'value')
    assert.equal(returned.returned, true)
    assert.equal(returned.finalized, true)
    assert.equal(returned.patched, undefined)
    assert.equal(publications.length, 1)
  })

  it('fails open for unsafe CommonJS wrapper bindings', () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'unsafe-package', {
      main: 'index.js',
      version: '1.0.0',
    })
    const resourcePath = write(packageDir, 'index.js', 'module.exports = true\n')
    const instrumentations = {}
    const hook = sinon.stub().callsFake(() => {
      instrumentations['unsafe-package'] = [{ hook: sinon.stub(), versions: ['1'] }]
    })
    const { loader } = loadLoader({ hooks: { 'unsafe-package': hook }, instrumentations })
    const sourceMap = { mappings: 'AAAA', sources: ['input.js'], version: 3 }
    const sources = [
      'function require () { return true }\nmodule.exports = { value: require() }\n',
      'module.exports = { before: typeof require }\nvar require = () => false\n',
      'const original = module\nrequire = () => false\noriginal.exports = { value: true }\n',
      '({ require } = { require: () => false })\nmodule.exports = { value: true }\n',
      '({ require = () => false } = {})\nmodule.exports = { value: true }\n',
      '({ ...require } = { value: true })\nmodule.exports = { value: true }\n',
      '[require] = [() => false]\nmodule.exports = { value: true }\n',
      '[...require] = [() => false]\nmodule.exports = { value: true }\n',
      'for (require of [() => false]) {}\nmodule.exports = { value: true }\n',
      'for (require in { value: true }) {}\nmodule.exports = { value: true }\n',
      'require++\nmodule.exports = { value: true }\n',
      "eval('require = () => false')\nmodule.exports = { value: true }\n",
      'arguments[1] = () => false\nmodule.exports = { value: true }\n',
      'const mutate = () => { arguments[1] = () => false }\nmutate()\nmodule.exports = { value: true }\n',
      'const args = arguments\nargs[1] = () => false\nmodule.exports = { value: true }\n',
      'const value = { arguments }\nmodule.exports = { value }\n',
      'var module = { exports: { value: true } }\n',
      'function {\n',
    ]

    for (const source of sources) {
      const emitWarning = sinon.spy()
      const result = runLoader(loader, resourcePath, source, sourceMap, emitWarning)

      assert.equal(result.code, source)
      assert.strictEqual(result.sourceMap, sourceMap)
      sinon.assert.calledOnceWithExactly(
        emitWarning,
        sinon.match.has('message', sinon.match(/unsafe wrapper bindings/))
      )
    }
  })

  it('rewrites source targets independently of build-process disablement', () => {
    const runner = path.join(__dirname, 'resources/run-loader-with-build-config.js')
    const { disabled, enabled } = JSON.parse(execFileSync(process.execPath, [runner], { encoding: 'utf8' }))

    for (let index = 0; index < enabled.length; index++) {
      assert.match(enabled[index], /tr_ch_apm_tracingChannel/)
      assert.equal(disabled[index], enabled[index])
    }
  })

  it('matches exact files and file patterns against the resolved package path', () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, '@scope/test-package', {
      main: 'index.js',
      version: '2.0.0',
    })
    write(packageDir, 'index.js', 'module.exports = {}\n')
    const exactPath = write(packageDir, 'lib/exact.js', 'module.exports = {}\n')
    const patternPath = write(packageDir, 'lib/chunk-one.js', 'module.exports = {}\n')
    const instrumentations = {}
    const hook = sinon.stub().callsFake(() => {
      instrumentations['@scope/test-package'] = [
        { file: 'lib/exact.js', hook: sinon.stub() },
        { filePattern: String.raw`lib/chunk-.*\.js`, hook: sinon.stub() },
      ]
    })
    const { loader } = loadLoader({ hooks: { '@scope/test-package': hook }, instrumentations })

    const exact = runLoader(loader, exactPath, fs.readFileSync(exactPath, 'utf8'))
    const pattern = runLoader(loader, patternPath, fs.readFileSync(patternPath, 'utf8'))

    assert.match(exact.code, /"@scope\/test-package\/lib\/exact\.js"/)
    assert.match(pattern.code, /"@scope\/test-package\/lib\/chunk-one\.js"/)
    sinon.assert.calledOnceWithExactly(hook)
  })

  it('uses the innermost package for nested dependencies', () => {
    const projectDir = createProject()
    const outerPackageDir = createPackage(projectDir, 'outer-package', { version: '1.0.0' })
    const packageDir = createPackage(outerPackageDir, 'nested-package', {
      main: 'index.js',
      version: '2.0.0',
    })
    const resourcePath = write(packageDir, 'index.js', 'module.exports = true\n')
    const instrumentations = {}
    const hook = sinon.stub().callsFake(() => {
      instrumentations['nested-package'] = [{ hook: sinon.stub(), versions: ['2'] }]
    })
    const { loader } = loadLoader({ hooks: { 'nested-package': hook }, instrumentations })

    const result = runLoader(loader, resourcePath, fs.readFileSync(resourcePath, 'utf8'))
    const payloads = []
    executeCommonJs(result.code, payload => payloads.push(payload))

    assert.equal(payloads.length, 1)
    assert.equal(payloads[0].package, 'nested-package')
    assert.equal(payloads[0].path, 'nested-package')
    assert.equal(payloads[0].version, '2.0.0')
  })

  it('recovers a synthetic extensionless path without stripping normal JavaScript paths', () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'extensionless-package', {
      main: 'runner',
      version: '3.0.0',
    })
    const resourcePath = write(packageDir, 'runner', '#!/usr/bin/env node\nmodule.exports = function run () {}\n')
    const javascriptPath = write(packageDir, 'runner.js', 'module.exports = true\n')
    const markedPath = write(packageDir, 'marked.__dd_trace_turbopack.js', 'module.exports = "marked"\n')
    const instrumentations = {}
    const hook = sinon.stub().callsFake(() => {
      instrumentations['extensionless-package'] = [{ hook: sinon.stub(), versions: ['3'] }]
    })
    const { loader } = loadLoader({ hooks: { 'extensionless-package': hook }, instrumentations })

    const result = runLoader(
      loader,
      `${resourcePath}.__dd_trace_turbopack.js`,
      fs.readFileSync(resourcePath, 'utf8')
    )
    const javascript = runLoader(loader, javascriptPath, fs.readFileSync(javascriptPath, 'utf8'))
    const marked = runLoader(loader, markedPath, fs.readFileSync(markedPath, 'utf8'))
    const error = runFailedLoader(
      loader,
      path.join(packageDir, 'missing.__dd_trace_turbopack.js'),
      'module.exports = false\n'
    )

    assert.match(result.code, /package: "extensionless-package"/)
    assert.match(result.code, /path: "extensionless-package"/)
    assert.match(result.code, /version: "3\.0\.0"/)
    assert.equal(javascript.code, 'module.exports = true\n')
    assert.equal(marked.code, 'module.exports = "marked"\n')
    assert.equal(error.code, 'ENOENT')
  })

  it('rewrites an ESM target and appends subscriber-gated activation', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'rewrite-package', {
      type: 'module',
      version: '4.0.0',
    })
    const resourcePath = write(packageDir, 'dist/index.mjs', 'export function run () {}\n')
    const normalizedResourcePath = fs.realpathSync(resourcePath).replaceAll('\\', '/')
    const sourceMap = { mappings: 'AAAA', version: 3 }
    const outputMap = JSON.stringify({ mappings: 'BBBB', version: 3 })
    const rewrite = sinon.stub().returns({
      code: 'export function run () {}\n// rewritten',
      map: outputMap,
    })
    const packageHook = sinon.stub()
    const rewriteTarget = { filePath: 'dist/index.mjs', moduleName: 'rewrite-package' }
    const { loader, rewriteFactory } = loadLoader({
      hooks: { 'rewrite-package': packageHook },
      instrumentations: {},
      rewrite,
      rewriteTarget: path => path === normalizedResourcePath ? rewriteTarget : undefined,
      rewriteTargets: { 'rewrite-package/dist/index.mjs': 'rewrite-package' },
    })

    const result = runLoader(loader, resourcePath, fs.readFileSync(resourcePath, 'utf8'), sourceMap)
    const dcModule = rewriteFactory.firstCall.args[0]

    assert.match(dcModule, /^\.\.\//)
    assert.match(result.code, /\/\/ rewritten/)
    assert.match(result.code, new RegExp(`import ddTraceTurbopackDc from ${escapeRegExp(JSON.stringify(dcModule))}`))
    assert.match(result.code, /channel\.hasSubscribers/)
    assert.match(result.code, /"activate":true,"package":"rewrite-package"/)
    assert.match(result.code, /"path":"rewrite-package\/dist\/index\.mjs","version":"4\.0\.0"/)
    assert.strictEqual(result.sourceMap, outputMap)
    const outputPath = write(packageDir, 'output.mjs', result.code)
    const namespace = await import(pathToFileURL(outputPath).href)
    assert.equal(typeof namespace.run, 'function')
    sinon.assert.notCalled(packageHook)
    sinon.assert.calledOnceWithExactly(
      rewrite,
      fs.readFileSync(resourcePath, 'utf8'),
      normalizedResourcePath,
      'module',
      rewriteTarget,
      sourceMap
    )
  })

  it('activates a rewritten CommonJS target only when no export hook matched', () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'rewrite-package', { version: '1.0.0' })
    const resourcePath = write(packageDir, 'index.js', 'module.exports = true\n')
    const rewrite = sinon.stub().returns({ code: 'module.exports = true\n// rewritten', map: undefined })
    const rewriteTarget = { filePath: 'index.js', moduleName: 'rewrite-package' }
    const { loader } = loadLoader({
      hooks: { 'rewrite-package': sinon.stub() },
      instrumentations: {},
      rewrite,
      rewriteTarget: () => rewriteTarget,
      rewriteTargets: { 'rewrite-package/index.js': 'rewrite-package' },
    })

    const result = runLoader(loader, resourcePath, fs.readFileSync(resourcePath, 'utf8'))

    assert.match(result.code, /const dc = require\("\.\.\//)
    assert.match(result.code, /"activate":true,"package":"rewrite-package"/)

    const publishedPackageDir = createPackage(projectDir, 'published-rewrite-package', { version: '2.0.0' })
    const publishedPath = write(
      publishedPackageDir,
      'dist/index.js',
      'module.exports = { original: true }\n'
    )
    const publishedInstrumentations = {}
    const publishedHook = sinon.stub().callsFake(() => {
      publishedInstrumentations['published-rewrite-package'] = [{
        file: 'dist/index.js',
        hook: sinon.stub(),
        versions: ['2'],
      }]
    })
    const publishedTarget = { filePath: 'dist/index.js', moduleName: 'published-rewrite-package' }
    const publishedRewrite = sinon.stub().returns({
      code: 'module.exports = { original: true }\n// rewritten',
      map: undefined,
    })
    const { loader: publishedLoader } = loadLoader({
      hooks: { 'published-rewrite-package': publishedHook },
      instrumentations: publishedInstrumentations,
      rewrite: publishedRewrite,
      rewriteTarget: () => publishedTarget,
      rewriteTargets: { 'published-rewrite-package/dist/index.js': 'published-rewrite-package' },
    })

    const published = runLoader(publishedLoader, publishedPath, fs.readFileSync(publishedPath, 'utf8'))
    const payloads = []
    const exports = executeCommonJs(published.code, payload => payloads.push(payload))

    assert.match(published.code, /\/\/ rewritten/)
    assert.doesNotMatch(published.code, /"activate":true/)
    assert.deepStrictEqual(payloads.map(({ package: name, path, version }) => ({ name, path, version })), [{
      name: 'published-rewrite-package',
      path: 'published-rewrite-package/dist/index.js',
      version: '2.0.0',
    }])
    assert.equal(exports.original, true)
  })

  it('preserves irrelevant resources and fails builds for known target errors', () => {
    const projectDir = createProject()
    const unrelatedDir = createPackage(projectDir, 'unrelated', { version: '1.0.0' })
    const unrelatedPath = write(unrelatedDir, 'index.js', 'module.exports = true\n')
    const brokenDir = createPackage(projectDir, 'broken-package', { version: '1.0.0' })
    const brokenPath = write(brokenDir, 'index.js', 'module.exports = false\n')
    fs.writeFileSync(path.join(brokenDir, 'package.json'), '{')
    const sourceMap = { mappings: 'AAAA', version: 3 }
    const hook = sinon.stub()
    const { loader, rewriteFactory } = loadLoader({
      hooks: { 'broken-package': hook },
      instrumentations: {},
    })

    const unrelated = runLoader(loader, unrelatedPath, fs.readFileSync(unrelatedPath, 'utf8'), sourceMap)
    const error = runFailedLoader(loader, brokenPath, fs.readFileSync(brokenPath, 'utf8'), sourceMap)

    assert.equal(unrelated.code, 'module.exports = true\n')
    assert.strictEqual(unrelated.sourceMap, sourceMap)
    assert.equal(error instanceof SyntaxError, true)
    sinon.assert.notCalled(hook)
    sinon.assert.notCalled(rewriteFactory)
  })
})

/**
 * @param {{
 *   hooks: Record<string, Function|{ fn: Function }>,
 *   instrumentations: Record<string, object[]>,
 *   rewrite?: Function,
 *   rewriteTarget?: (path: string) => object|undefined,
 *   rewriteTargets?: Record<string, string>
 * }} options
 * @returns {{ loader: Function, rewriteFactory: import('sinon').SinonStub }}
 */
function loadLoader ({
  hooks,
  instrumentations,
  rewrite = sinon.stub().callsFake((source, _path, _format, _target, map) => ({ code: source, map })),
  rewriteTarget = () => undefined,
  rewriteTargets = {},
}) {
  const originalRequire = Module.prototype.require
  const rewriteFactory = sinon.stub().returns(rewrite)
  Module.prototype.require = function (request) {
    if (this.filename === loaderPath) {
      const stubs = {
        '../../datadog-instrumentations/src/helpers/hooks': hooks,
        '../../datadog-instrumentations/src/helpers/instrumentations': instrumentations,
        '../../datadog-instrumentations/src/helpers/rewriter': { createBundlerRewriter: rewriteFactory },
        '../../datadog-instrumentations/src/helpers/rewriter/targets': { getRewriteTarget: rewriteTarget },
        '../../datadog-instrumentations/src/helpers/rewriter/targets.json': rewriteTargets,
      }
      if (stubs[request]) return stubs[request]
    }
    return originalRequire.call(this, request)
  }
  delete require.cache[loaderPath]
  const loader = require('../src/loader')
  Module.prototype.require = originalRequire
  return { loader, rewriteFactory }
}

/**
 * @param {Function} loader
 * @param {string} resourcePath
 * @param {string} source
 * @param {object} [sourceMap]
 * @param {(warning: Error) => void} [emitWarning]
 * @returns {{ code: string, sourceMap: object|undefined }}
 */
function runLoader (loader, resourcePath, source, sourceMap, emitWarning) {
  const callback = sinon.spy()
  loader.call({ callback, emitWarning, resourcePath }, source, sourceMap)
  sinon.assert.calledOnce(callback)
  assert.equal(callback.firstCall.args[0], undefined)
  return { code: callback.firstCall.args[1], sourceMap: callback.firstCall.args[2] }
}

/**
 * @param {Function} loader
 * @param {string} resourcePath
 * @param {string} source
 * @param {object} [sourceMap]
 * @returns {Error}
 */
function runFailedLoader (loader, resourcePath, source, sourceMap) {
  const callback = sinon.spy()
  loader.call({ callback, resourcePath }, source, sourceMap)
  sinon.assert.calledOnce(callback)
  sinon.assert.calledWithExactly(callback, sinon.match.instanceOf(Error))
  return callback.firstCall.args[0]
}

/**
 * @param {string} code
 * @param {(payload: { module: object, path: string }) => void} publish
 * @param {boolean} [hasSubscribers]
 * @param {object} [context]
 * @returns {object}
 */
function executeCommonJs (code, publish, hasSubscribers = true, context = {}) {
  const module = { exports: {} }
  const require = request => {
    assert.equal(request.startsWith('.'), true)
    return {
      channel: name => {
        assert.equal(name, 'dd-trace:bundler:load')
        return { hasSubscribers, publish }
      },
    }
  }
  const wrapper = vm.runInNewContext(Module.wrap(code), context)
  wrapper.call(module.exports, module.exports, require, module, 'fixture.js', '/')
  return module.exports
}

function createProject () {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-turbopack-loader-'))
  directories.push(projectDir)
  return projectDir
}

/**
 * @param {string} projectDir
 * @param {string} name
 * @param {object} packageJson
 * @param {boolean} [pnpm]
 * @returns {string}
 */
function createPackage (projectDir, name, packageJson, pnpm = false) {
  const packageDir = pnpm
    ? path.join(projectDir, 'node_modules', '.pnpm', `${name}@${packageJson.version}`, 'node_modules', name)
    : path.join(projectDir, 'node_modules', name)
  fs.mkdirSync(packageDir, { recursive: true })
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name, ...packageJson }))
  return packageDir
}

/**
 * @param {string} directory
 * @param {string} file
 * @param {string} source
 * @returns {string}
 */
function write (directory, file, source) {
  const target = path.join(directory, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, source)
  return target
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp (value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}
