'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const vm = require('node:vm')

const dc = require('dc-polyfill')
const sinon = require('sinon')

const helperPath = require.resolve('../../src/helpers/bundler-transform')
const directories = []

describe('bundler transform', () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { force: true, recursive: true })
    delete require.cache[helperPath]
    sinon.restore()
  })

  it('classifies matching files and respects ESM package requests and hook versions', () => {
    const projectDir = createProject()
    const cjs = createPackage(projectDir, 'commonjs-package', { main: 'index.js', version: '2.0.0' })
    const dual = createPackage(projectDir, 'dual-package', {
      exports: { import: './index.mjs', require: './index.cjs' },
      version: '2.0.0',
    })
    const unrelated = createPackage(projectDir, 'unrelated', { version: '1.0.0' })
    const cjsRoot = write(cjs, 'index.js', 'module.exports = true\n')
    const cjsFile = write(cjs, 'lib/file.js', 'module.exports = true\n')
    const cjsUnmatched = write(cjs, 'other.js', 'module.exports = true\n')
    const esmRoot = write(dual, 'index.mjs', 'export default true\n')
    const esmFile = write(dual, 'lib/file.mjs', 'export default true\n')
    const esmUnmatched = write(dual, 'other.mjs', 'export default true\n')
    write(dual, 'index.cjs', 'module.exports = true\n')
    const unrelatedFile = write(unrelated, 'index.js', 'module.exports = true\n')
    const instrumentations = {}
    const hooks = {
      'commonjs-package': () => {
        instrumentations['commonjs-package'] = [
          { versions: ['>=2'] },
          { file: 'lib/file.js', versions: ['>=2'] },
          { file: 'other.js', versions: ['>=3'] },
        ]
      },
      'dual-package': () => {
        instrumentations['dual-package'] = [
          { versions: ['>=2'] },
          { filePattern: String.raw`lib/.*\.mjs`, versions: ['>=2'] },
          { file: 'other.mjs', versions: ['>=3'] },
        ]
      },
    }
    const { classify, instrument } = loadHelper({ hooks, instrumentations })

    assert.equal(classify({ resourcePath: cjsRoot }), 'cjs-publication')
    assert.equal(classify({ resourcePath: cjsFile }), 'cjs-publication')
    assert.equal(classify({ resourcePath: cjsUnmatched }), 'none')
    assert.equal(classify({ resourcePath: esmRoot, request: 'dual-package' }), 'esm-intercept')
    assert.equal(classify({ resourcePath: esmRoot }), 'none')
    assert.equal(classify({ resourcePath: esmFile }), 'esm-intercept')
    assert.equal(classify({ resourcePath: esmUnmatched, request: './other.mjs' }), 'none')
    assert.equal(classify({ resourcePath: unrelatedFile }), 'none')
    assert.equal(instrument({ resourcePath: esmRoot, source: 'export default true\n' }), undefined)
    assert.equal(instrument({ resourcePath: unrelatedFile, source: 'module.exports = true\n' }), undefined)
  })

  it('classifies rewrites first while preserving matching CJS publications', () => {
    const projectDir = createProject()
    const cjs = createPackage(projectDir, 'rewrite-package', { main: 'index.js', version: '1.0.0' })
    const esm = createPackage(projectDir, 'esm-rewrite-package', { type: 'module', version: '1.0.0' })
    const source = 'module.exports = { original: true }\n'
    const cjsFile = write(cjs, 'index.js', source)
    const esmFile = write(esm, 'index.js', 'export default true\n')
    const instrumentations = {}
    const esmHook = sinon.spy()
    const hooks = {
      'rewrite-package': () => { instrumentations['rewrite-package'] = [{ versions: ['1'] }] },
      'esm-rewrite-package': esmHook,
    }
    const rewriteTarget = resourcePath => ({
      moduleName: resourcePath.includes('/esm-rewrite-package/') ? 'esm-rewrite-package' : 'rewrite-package',
      filePath: 'index.js',
    })
    const rewrite = sinon.stub().callsFake((source, _path, _format, _target, map) => ({
      code: `${source}// rewritten\n`, map,
    }))
    const { classify, instrument } = loadHelper({ hooks, instrumentations, rewrite, rewriteTarget })
    const sourceMap = { mappings: 'AAAA', version: 3 }

    assert.equal(classify({ resourcePath: cjsFile }), 'orchestrion-rewrite')
    assert.equal(classify({ resourcePath: esmFile, request: 'esm-rewrite-package' }), 'orchestrion-rewrite')
    sinon.assert.notCalled(esmHook)
    const result = instrument({ source, resourcePath: cjsFile, inputSourceMap: sourceMap })
    assert.ok(result)
    const payloads = []
    const exports = executeCommonJs(result.code, payload => payloads.push(payload))
    assert.match(result.code, /\/\/ rewritten/)
    assert.doesNotMatch(result.code, /"activate":true/)
    assert.deepStrictEqual(payloads.map(({ package: name, path, version }) => ({ name, path, version })), [{
      name: 'rewrite-package',
      path: 'rewrite-package',
      version: '1.0.0',
    }])
    assert.equal(exports.original, true)
    assert.strictEqual(result.map, sourceMap)
  })

  it('fails open with a warning for unsafe CJS activation', () => {
    const projectDir = createProject()
    const rewritten = createPackage(projectDir, 'rewritten-package', { version: '1.0.0' })
    const unsafe = 'function require () {}\nmodule.exports = true\n'
    const rewrittenFile = write(rewritten, 'index.js', unsafe)
    const target = { moduleName: 'rewritten-package', filePath: 'index.js' }
    const rewrite = sinon.stub().returns({ code: `${unsafe}// rewritten\n` })
    const { instrument } = loadHelper({
      hooks: { 'rewritten-package': () => {} },
      instrumentations: {},
      rewrite,
      rewriteTarget: () => target,
    })
    const sourceMap = { mappings: 'AAAA', version: 3 }
    const warn = sinon.spy()

    assert.equal(instrument({ source: unsafe, resourcePath: rewrittenFile, inputSourceMap: sourceMap, warn }),
      undefined)
    sinon.assert.calledOnceWithExactly(
      warn,
      sinon.match.has('message', sinon.match(/Skipped CommonJS activation for unsafe wrapper bindings/))
    )
    sinon.assert.calledOnceWithExactly(
      rewrite,
      unsafe,
      fs.realpathSync(rewrittenFile).replaceAll('\\', '/'),
      'commonjs',
      target,
      sourceMap
    )
  })

  it('fails open for rewriter errors, including non-Error throws and throwing warning handlers', () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'error-package', { version: '1.0.0' })
    const source = 'module.exports = true\n'
    const resourcePath = write(packageDir, 'index.js', source)
    const failure = 'rewrite failed'
    const rewrite = sinon.stub().callsFake(() => { throw failure })
    const rewriteTarget = () => ({ moduleName: 'error-package', filePath: 'index.js', activate: true })
    const { instrument, classify } = loadHelper({
      hooks: {}, instrumentations: {}, rewrite, rewriteTarget, rewriteTargetNames: ['error-package'],
    })
    const warn = sinon.spy()

    assert.equal(instrument({ source, resourcePath, warn }), undefined)
    sinon.assert.calledOnceWithExactly(warn, sinon.match.has('message', 'rewrite failed'))
    assert.equal(instrument({ source, resourcePath, warn: () => { throw new Error('warning failed') } }), undefined)
    const missing = path.join(packageDir, 'missing.js')
    assert.equal(classify({ resourcePath: missing, warn }), 'none')
    assert.equal(warn.secondCall.args[0].code, 'ENOENT')
  })

  it('preserves errors handled internally by the real rewriter', () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'bullmq', { version: '5.66.0' })
    const source = 'class Queue {'
    const resourcePath = write(packageDir, 'dist/cjs/classes/queue.js', source)
    const sourceMap = { mappings: 'AAAA', version: 3 }
    const warn = sinon.spy()
    const log = require('../../../dd-trace/src/log')
    const logError = sinon.stub(log, 'error')
    const { instrument } = require('../../src/helpers/bundler-transform')

    const result = instrument({ source, resourcePath, inputSourceMap: sourceMap, warn })

    assert.ok(result)
    assert.equal(result.code, source)
    assert.strictEqual(result.map, sourceMap)
    sinon.assert.calledOnce(logError)
    sinon.assert.notCalled(warn)
  })

  it('inserts a relative path to the tracer diagnostic-channel module', () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'relative-package', { main: 'index.js', version: '1.0.0' })
    const source = 'module.exports = true\n'
    const resourcePath = write(packageDir, 'index.js', source)
    const instrumentations = {}
    const hooks = { 'relative-package': () => { instrumentations['relative-package'] = [{}] } }
    const { instrument } = loadHelper({ hooks, instrumentations })
    const expected = path.relative(path.dirname(fs.realpathSync(resourcePath)), require.resolve('dc-polyfill'))
      .replaceAll('\\', '/')
    const specifier = expected.startsWith('../') ? expected : `./${expected}`

    const result = instrument({ source, resourcePath })
    assert.ok(result)
    assert.ok(result.code.includes(`require(${JSON.stringify(specifier)})`))
    assert.ok(specifier.startsWith('./') || specifier.startsWith('../'))
  })

  it('prefixes dot-directory imports and rejects paths on a different drive', () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'relative-package', { main: 'index.js', version: '1.0.0' })
    const source = 'module.exports = true\n'
    const resourcePath = write(packageDir, 'index.js', source)
    const instrumentations = {}
    const hooks = { 'relative-package': () => { instrumentations['relative-package'] = [{}] } }
    const { instrument } = loadHelper({ hooks, instrumentations, relativePath: '.dependencies/dc-polyfill.js' })

    const result = instrument({ source, resourcePath })
    assert.ok(result)
    assert.match(result.code, /require\("\.\/.dependencies\/dc-polyfill\.js"\)/)
    const otherDrive = loadHelper({ hooks, instrumentations, relativePath: 'D:\\dependencies\\dc-polyfill.js' })
    const warn = sinon.spy()
    assert.equal(otherDrive.instrument({ source, resourcePath, warn }), undefined)
    sinon.assert.calledOnceWithExactly(warn, sinon.match.has('message', sinon.match(/relative diagnostic-channel import/)))
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
    const internalSource = 'module.exports = { internal: true }\n'
    const internalPath = write(packageDir, 'internal.js', internalSource)
    const targetHook = sinon.stub().callsFake(() => {
      instrumentations['test-package'] = [
        { hook: sinon.stub(), versions: ['>=1'] },
        { file: 'index.js', hook: sinon.stub(), versions: ['>=1'] },
      ]
    })
    const otherHook = sinon.stub()
    const instrumentations = {}
    const { instrument, rewriteFactory } = loadHelper({
      hooks: { 'other-package': otherHook, 'test-package': targetHook },
      instrumentations,
    })
    const sourceMap = { mappings: 'AAAA', version: 3 }

    const result = instrument({ source, resourcePath, inputSourceMap: sourceMap })
    assert.ok(result)
    const paths = []
    const exports = executeCommonJs(result.code, (payload) => {
      paths.push(payload.path)
      payload.module = { ...payload.module, [payload.path]: true }
    })

    assert.deepStrictEqual(paths, ['test-package', 'test-package/index.js'])
    assert.deepStrictEqual(exports, {
      original: true,
      'test-package': true,
      'test-package/index.js': true,
    })
    assert.strictEqual(result.map, sourceMap)
    assert.equal(instrument({ source: internalSource, resourcePath: internalPath, inputSourceMap: sourceMap }),
      undefined)
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
    const { instrument } = loadHelper({ hooks: { 'fallthrough-package': hook }, instrumentations })
    const result = instrument({ source, resourcePath })
    assert.ok(result)
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
    const { instrument } = loadHelper({ hooks: { 'unsafe-package': hook }, instrumentations })
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
      const warn = sinon.spy()

      assert.equal(instrument({ source, resourcePath, warn }), undefined)
      sinon.assert.calledOnceWithExactly(
        warn,
        sinon.match.has('message', sinon.match(/Skipped CommonJS publication for unsafe wrapper bindings/))
      )
    }
  })

  it('publishes modules with mutations to shadowed CommonJS bindings', () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'shadowed-package', {
      main: 'index.js',
      version: '1.0.0',
    })
    const resourcePath = write(packageDir, 'index.js', 'module.exports = true\n')
    const instrumentations = {}
    const hook = sinon.stub().callsFake(() => {
      instrumentations['shadowed-package'] = [{ hook: sinon.stub(), versions: ['1'] }]
    })
    const { instrument } = loadHelper({ hooks: { 'shadowed-package': hook }, instrumentations })
    const sources = [
      'function configure(require) { require = () => false }\nmodule.exports = configure\n',
      'function configure() { var module; module = { exports: false } }\nmodule.exports = configure\n',
      '{ let require; require = () => false }\nmodule.exports = true\n',
      'try {} catch (module) { module = true }\nmodule.exports = true\n',
      'switch (0) { case 0: let require; require = () => false }\nmodule.exports = true\n',
      'for (let require = false; require; require = false) {}\nmodule.exports = true\n',
      'for (let module of []) { module = false }\nmodule.exports = true\n',
      'const value = class module { static configure() { module = false } }\nmodule.exports = value\n',
    ]

    for (const source of sources) {
      const publications = []
      const result = instrument({ source, resourcePath })
      assert.ok(result)
      const exports = executeCommonJs(result.code, payload => publications.push(payload))

      assert.notEqual(result.code, source)
      assert.ok(exports)
      assert.equal(publications.length, 1)
    }
  })

  it('matches exact files and file patterns against the resolved package path', () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, '@scope/test-package', {
      main: 'index.js',
      version: '2.0.0',
    })
    write(packageDir, 'index.js', 'module.exports = {}\n')
    const source = 'module.exports = {}\n'
    const exactPath = write(packageDir, 'lib/exact.js', source)
    const patternPath = write(packageDir, 'lib/chunk-one.js', source)
    const instrumentations = {}
    const hook = sinon.stub().callsFake(() => {
      instrumentations['@scope/test-package'] = [
        { file: 'lib/exact.js', hook: sinon.stub() },
        { filePattern: String.raw`lib/chunk-.*\.js`, hook: sinon.stub() },
      ]
    })
    const { instrument } = loadHelper({ hooks: { '@scope/test-package': hook }, instrumentations })

    const exact = instrument({ source, resourcePath: exactPath })
    const pattern = instrument({ source, resourcePath: patternPath })

    assert.ok(exact && pattern)
    assert.match(exact.code, /"@scope\/test-package\/lib\/exact\.js"/)
    assert.match(pattern.code, /"@scope\/test-package\/lib\/chunk-one\.js"/)
    sinon.assert.calledOnceWithExactly(hook)
  })

  it('resolves a package root when its exports map hides the package entrypoint', () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'hidden-entrypoint-package', {
      exports: {},
      main: 'index.js',
      version: '1.0.0',
    })
    const source = 'module.exports = true\n'
    const resourcePath = write(packageDir, 'index.js', source)
    const instrumentations = {}
    const hook = sinon.stub().callsFake(() => {
      instrumentations['hidden-entrypoint-package'] = [{ hook: sinon.stub(), versions: ['1'] }]
    })
    const { instrument } = loadHelper({ hooks: { 'hidden-entrypoint-package': hook }, instrumentations })

    const result = instrument({ source, resourcePath })

    assert.ok(result)
    assert.match(result.code, /package: "hidden-entrypoint-package"/)
    assert.match(result.code, /path: "hidden-entrypoint-package"/)
    sinon.assert.calledOnceWithExactly(hook)
  })

  it('uses the innermost package for nested dependencies', () => {
    const projectDir = createProject()
    const outerPackageDir = createPackage(projectDir, 'outer-package', { version: '1.0.0' })
    const packageDir = createPackage(outerPackageDir, 'nested-package', {
      main: 'index.js',
      version: '2.0.0',
    })
    const source = 'module.exports = true\n'
    const resourcePath = write(packageDir, 'index.js', source)
    const instrumentations = {}
    const hook = sinon.stub().callsFake(() => {
      instrumentations['nested-package'] = [{ hook: sinon.stub(), versions: ['2'] }]
    })
    const { instrument } = loadHelper({ hooks: { 'nested-package': hook }, instrumentations })

    const result = instrument({ source, resourcePath })
    assert.ok(result)
    const payloads = []
    executeCommonJs(result.code, payload => payloads.push(payload))

    assert.equal(payloads.length, 1)
    assert.equal(payloads[0].package, 'nested-package')
    assert.equal(payloads[0].path, 'nested-package')
    assert.equal(payloads[0].version, '2.0.0')
  })

  it('rewrites an ESM target and appends subscriber-gated activation', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'rewrite-package', {
      type: 'module',
      version: '4.0.0',
    })
    const source = 'export function run () {}\n'
    const resourcePath = write(packageDir, 'dist/index.mjs', source)
    const normalizedResourcePath = fs.realpathSync(resourcePath).replaceAll('\\', '/')
    const sourceMap = { mappings: 'AAAA', version: 3 }
    const outputMap = JSON.stringify({ mappings: 'BBBB', version: 3 })
    const rewrite = sinon.stub().returns({
      code: 'export function run () {}\n// rewritten',
      map: outputMap,
    })
    const packageHook = sinon.stub()
    const rewriteTarget = { filePath: 'dist/index.mjs', moduleName: 'rewrite-package' }
    const { instrument, rewriteFactory } = loadHelper({
      hooks: { 'rewrite-package': packageHook },
      instrumentations: {},
      rewrite,
      rewriteTarget: path => path === normalizedResourcePath ? rewriteTarget : undefined,
    })

    const result = instrument({ source, resourcePath, inputSourceMap: sourceMap })
    assert.ok(result)
    const dcModule = rewriteFactory.firstCall.args[0]

    assert.match(dcModule, /^\.\.\//)
    assert.match(result.code, /\/\/ rewritten/)
    assert.match(result.code, new RegExp(`import ddTraceBundlerDc from ${escapeRegExp(JSON.stringify(dcModule))}`))
    assert.match(result.code, /channel\.hasSubscribers/)
    assert.match(result.code, /"activate":true,"package":"rewrite-package"/)
    assert.equal(result.code.match(/"activate":true/g)?.length, 1)
    assert.match(result.code, /"path":"rewrite-package\/dist\/index\.mjs","version":"4\.0\.0"/)
    assert.strictEqual(result.map, outputMap)
    const outputPath = write(packageDir, 'output.mjs', result.code)
    const namespace = await import(pathToFileURL(outputPath).href)
    assert.equal(typeof namespace.run, 'function')
    sinon.assert.notCalled(packageHook)
    sinon.assert.calledOnceWithExactly(rewrite, source, normalizedResourcePath, 'module', rewriteTarget, sourceMap)
  })

  it('activates a rewritten CommonJS target when its package hook has no matching export hook', () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'rewrite-package', { version: '1.0.0' })
    const source = 'module.exports = true\n'
    const resourcePath = write(packageDir, 'index.js', source)
    const rewrite = sinon.stub().returns({ code: 'module.exports = true\n// rewritten', map: undefined })
    const rewriteTarget = { filePath: 'index.js', moduleName: 'rewrite-package' }
    const { instrument } = loadHelper({
      hooks: { 'rewrite-package': sinon.stub() },
      instrumentations: {},
      rewrite,
      rewriteTarget: () => rewriteTarget,
    })

    const result = instrument({ source, resourcePath })

    assert.ok(result)
    assert.match(result.code, /const dc = require\("\.\.\//)
    assert.match(result.code, /"activate":true,"package":"rewrite-package"/)
    assert.equal(result.code.match(/"activate":true/g)?.length, 1)
  })

  it('discovers and activates standalone rewrite targets without a hook registration', () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'rewrite-only-package', { version: '1.0.0' })
    const source = 'module.exports = true\n'
    const resourcePath = write(packageDir, 'index.js', source)
    const rewrite = sinon.stub().returns({ code: `${source}// rewritten\n`, map: undefined })
    const rewriteTarget = {
      activate: true,
      filePath: 'index.js',
      moduleName: 'rewrite-only-package',
    }
    const { classify, instrument, rewriteFactory } = loadHelper({
      hooks: {},
      instrumentations: {},
      rewrite,
      rewriteTarget: () => rewriteTarget,
      rewriteTargetNames: ['rewrite-only-package'],
    })

    assert.equal(classify({ resourcePath }), 'orchestrion-rewrite')
    const result = instrument({ source, resourcePath })

    assert.ok(result)
    assert.match(result.code, /\/\/ rewritten/)
    assert.match(result.code, /"activate":true,"package":"rewrite-only-package"/)
    sinon.assert.calledOnce(rewrite)
    sinon.assert.calledOnce(rewriteFactory)
  })

  it('rewrites child targets without appending standalone activation', () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, '@wdio/runner', { version: '9.0.0' })
    const source = 'module.exports = true\n'
    const resourcePath = write(packageDir, 'build/index.js', source)
    const rewrittenSource = `${source}// rewritten\n`
    const rewrite = sinon.stub().returns({ code: rewrittenSource, map: undefined })
    const rewriteTarget = { filePath: 'build/index.js', moduleName: '@wdio/runner' }
    const { instrument } = loadHelper({
      hooks: {},
      instrumentations: {},
      rewrite,
      rewriteTarget: () => rewriteTarget,
      rewriteTargetNames: ['@wdio/runner'],
    })

    const result = instrument({ source, resourcePath })

    assert.equal(result?.code, rewrittenSource)
    sinon.assert.calledOnce(rewrite)
  })

  it('rewrites real targets with export hooks', async () => {
    for (const esm of [false, true]) {
      const tracer = await runRealRewrite({
        channel: 'tracing:orchestrion:ai:getTracer:start',
        esm,
        file: esm ? 'dist/index.mjs' : 'dist/index.js',
        main: 'dist/index.js',
        name: 'ai',
        run: exports => exports.getTracer(),
        source: esm
          ? 'export function getTracer () { return "tracer" }\n'
          : 'function getTracer () { return "tracer" }\nmodule.exports = { getTracer }\n',
        version: '6.0.0',
      })

      assert.equal(tracer.value, 'tracer')
      assert.equal(tracer.starts, 1)
      assert.deepStrictEqual(tracer.payloads, esm
        ? [{ activate: true, package: 'ai', path: 'ai/dist/index.mjs', version: '6.0.0' }]
        : [{ hasModule: true, package: 'ai', path: 'ai', version: '6.0.0' }])
    }
  })

  it('rewrites and activates real hookless targets through bundler-register', () => {
    for (const esm of [false, true]) {
      assert.deepStrictEqual(runRealHooklessPipeline({ esm, version: '5.66.0' }), {
        activations: 1,
        bundlerEvents: 1,
        errors: 0,
        hasHook: false,
        hasMap: true,
        result: 'added',
        sequence: ['activation', 'start'],
        starts: 1,
        warnings: 0,
      })
      assert.deepStrictEqual(runRealHooklessPipeline({ esm, version: '5.65.0' }), {
        activations: 0,
        bundlerEvents: 0,
        errors: 0,
        hasHook: false,
        hasMap: false,
        result: 'added',
        sequence: [],
        starts: 0,
        warnings: 0,
      })
    }

    assert.deepStrictEqual(runRealHooklessPipeline({ disabled: true, esm: false, version: '5.66.0' }), {
      activations: 0,
      bundlerEvents: 1,
      errors: 0,
      hasHook: false,
      hasMap: true,
      result: 'added',
      sequence: [],
      starts: 0,
      warnings: 0,
    })
  })

  it('rewrites source targets independently of build-process disablement', () => {
    const runner = path.join(__dirname, 'bundler-transform/run-instrument-with-build-config.js')
    const enabled = JSON.parse(execFileSync(process.execPath, [runner], { encoding: 'utf8' }))
    const disabled = JSON.parse(execFileSync(process.execPath, [runner, 'disabled'], { encoding: 'utf8' }))

    assert.equal(enabled.length, 2)
    for (let index = 0; index < enabled.length; index++) {
      assert.match(enabled[index], /tr_ch_apm_tracingChannel/)
      assert.equal(disabled[index], enabled[index])
    }
  })

  it('fails open when a supported rewrite target has no package metadata', () => {
    const projectDir = createProject()
    const packageDir = path.join(projectDir, 'node_modules/metadata-less-package')
    const source = 'module.exports = true\n'
    const resourcePath = write(packageDir, 'index.js', source)
    const rewrite = sinon.stub()
    const warn = sinon.spy()
    const rewriteTarget = { filePath: 'index.js', moduleName: 'metadata-less-package' }
    const { instrument, rewriteFactory } = loadHelper({
      hooks: { 'metadata-less-package': sinon.stub() },
      instrumentations: {},
      rewrite,
      rewriteTarget: () => rewriteTarget,
    })

    assert.equal(instrument({ source, resourcePath, warn }), undefined)
    sinon.assert.calledOnceWithExactly(warn, sinon.match.has('code', 'ENOENT'))
    sinon.assert.notCalled(rewrite)
    sinon.assert.notCalled(rewriteFactory)
  })

  it('fails open for invalid package metadata', () => {
    const projectDir = createProject()
    const brokenDir = createPackage(projectDir, 'broken-package', { version: '1.0.0' })
    const source = 'module.exports = false\n'
    const brokenPath = write(brokenDir, 'index.js', source)
    fs.writeFileSync(path.join(brokenDir, 'package.json'), '{')
    const hook = sinon.stub()
    const { instrument, rewriteFactory } = loadHelper({
      hooks: { 'broken-package': hook },
      instrumentations: {},
    })
    const warn = sinon.spy()

    assert.equal(instrument({ source, resourcePath: brokenPath, warn }), undefined)
    sinon.assert.calledOnceWithExactly(warn, sinon.match.instanceOf(SyntaxError))
    sinon.assert.notCalled(hook)
    sinon.assert.notCalled(rewriteFactory)
  })

  it('normalizes non-Error hook failures and retries hook loading', () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'broken-hook-package', { version: '1.0.0' })
    const source = 'module.exports = true\n'
    const resourcePath = write(packageDir, 'index.js', source)
    const failure = 'hook failed'
    const instrumentations = {}
    const hook = sinon.stub()
    hook.onFirstCall().callsFake(() => {
      throw failure
    })
    hook.onSecondCall().callsFake(() => {
      instrumentations['broken-hook-package'] = [{ hook: sinon.stub(), versions: ['1'] }]
    })
    const warn = sinon.spy()
    const { instrument, rewriteFactory } = loadHelper({
      hooks: { 'broken-hook-package': hook },
      instrumentations,
    })

    const failed = instrument({ source, resourcePath, warn })
    const recovered = instrument({ source, resourcePath, warn })
    const repeated = instrument({ source, resourcePath, warn })

    assert.equal(failed, undefined)
    assert.notEqual(recovered?.code, source)
    assert.notEqual(repeated?.code, source)
    sinon.assert.calledOnceWithExactly(
      warn,
      sinon.match(value => value instanceof Error && value.message === 'hook failed')
    )
    sinon.assert.calledTwice(hook)
    sinon.assert.notCalled(rewriteFactory)
  })
})

function createProject () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-bundler-transform-'))
  directories.push(directory)
  return directory
}

/**
 * @param {string} projectDir
 * @param {string} name
 * @param {object} packageJson
 * @param {boolean} [pnpm]
 */
function createPackage (projectDir, name, packageJson, pnpm = false) {
  const directory = pnpm
    ? path.join(projectDir, 'node_modules', '.pnpm', `${name}@${packageJson.version}`, 'node_modules', name)
    : path.join(projectDir, 'node_modules', name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, ...packageJson }))
  return directory
}

/**
 * @param {string} directory
 * @param {string} file
 * @param {string} source
 */
function write (directory, file, source) {
  const resourcePath = path.join(directory, file)
  fs.mkdirSync(path.dirname(resourcePath), { recursive: true })
  fs.writeFileSync(resourcePath, source)
  return resourcePath
}

/**
 * @param {string} value
 */
function escapeRegExp (value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

/**
 * @param {{ hooks: object, instrumentations: object, relativePath?: string, rewrite?: Function,
 *   rewriteTarget?: Function, rewriteTargetNames?: string[] }} options
 * @returns {typeof import('../../src/helpers/bundler-transform') & { rewriteFactory: import('sinon').SinonStub }}
 */
function loadHelper ({
  hooks,
  instrumentations,
  relativePath,
  rewrite = sinon.stub().callsFake((source, _path, _format, _target, map) => ({ code: source, map })),
  rewriteTarget = () => undefined,
  rewriteTargetNames = Object.keys(hooks),
}) {
  const originalRequire = Module.prototype.require
  const rewriteFactory = sinon.stub().returns(rewrite)
  Module.prototype.require = function (request) {
    if (this.filename === helperPath) {
      const stubs = {
        './hooks': hooks,
        './instrumentations': instrumentations,
        './rewriter': { createBundlerRewriter: rewriteFactory },
        './rewriter/targets': {
          getRewriteTarget: rewriteTarget,
          getRewriteTargetNames: () => rewriteTargetNames.values(),
        },
        'node:path': relativePath ? { ...path, relative: () => relativePath } : path,
      }
      if (stubs[request]) return stubs[request]
    }
    return originalRequire.call(this, request)
  }
  delete require.cache[helperPath]
  try {
    return { ...require('../../src/helpers/bundler-transform'), rewriteFactory }
  } finally {
    Module.prototype.require = originalRequire
  }
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

/**
 * Instruments a fixture with the real rewriter and evaluates the output in this process.
 *
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
async function runRealRewrite ({ channel, esm, file, main, name, run, source, version }) {
  const projectDir = createProject()
  const packageDir = createPackage(projectDir, name, { main, type: esm ? 'module' : 'commonjs', version })
  const resourcePath = write(packageDir, file, source)
  const warn = sinon.spy()
  const { instrument } = require('../../src/helpers/bundler-transform')
  const result = instrument({ source, resourcePath, warn })
  sinon.assert.notCalled(warn)

  const outputPath = write(path.dirname(resourcePath), esm ? 'output.mjs' : 'output.cjs', result?.code ?? source)
  const payloads = []
  const onLoad = ({ module, ...payload }) => {
    payloads.push(module ? { hasModule: true, ...payload } : payload)
  }
  let starts = 0
  const onStart = () => { starts++ }
  dc.channel('dd-trace:bundler:load').subscribe(onLoad)
  dc.channel(channel).subscribe(onStart)
  try {
    const exports = esm ? await import(pathToFileURL(outputPath).href) : require(outputPath)
    const value = await run(exports)
    return { payloads, starts, value }
  } finally {
    dc.channel('dd-trace:bundler:load').unsubscribe(onLoad)
    dc.channel(channel).unsubscribe(onStart)
  }
}

/**
 * Instruments a BullMQ fixture at build time, then evaluates it with runtime bundler registration.
 *
 * @param {{ disabled?: boolean, esm: boolean, version: string }} options
 */
function runRealHooklessPipeline ({ disabled = false, esm, version }) {
  const projectDir = createProject()
  const packageDir = createPackage(projectDir, 'bullmq', { type: esm ? 'module' : 'commonjs', version })
  const relativePath = `dist/${esm ? 'esm' : 'cjs'}/classes/queue.js`
  const resourcePath = write(packageDir, relativePath, esm
    ? 'export class Queue { async add () { return "added" } }\n'
    : 'class Queue { async add () { return "added" } }\nmodule.exports = { Queue }\n')
  const tracingSubscription = disabled || version === '5.65.0'
    ? ''
    : `dc.tracingChannel('orchestrion:bullmq:Queue_add').subscribe({
      start () {
        starts++
        sequence.push('start')
      }
    })`
  const mainPath = write(projectDir, `main-${disabled}-${esm}-${version}.cjs`, `
    const fs = require('node:fs')
    const Module = require('node:module')
    const path = require('node:path')
    const { pathToFileURL } = require('node:url')
    const dc = require(${JSON.stringify(require.resolve('dc-polyfill'))})
    const hooks = require(${JSON.stringify(require.resolve('../../src/helpers/hooks'))})
    const log = require(${JSON.stringify(require.resolve('../../../dd-trace/src/log'))})
    const { instrument } = require(${JSON.stringify(helperPath)})

    // Source rewriting is build time, so it runs before any runtime
    // instrumentation registration or error capture.
    const resourcePath = ${JSON.stringify(resourcePath)}
    const source = fs.readFileSync(resourcePath, 'utf8')
    const warnings = []
    const result = instrument({ source, resourcePath, warn: warning => warnings.push(warning) })
    const output = result?.code ?? source

    // Error capture covers runtime bundler registration and evaluation only.
    const errors = []
    log.error = (...args) => errors.push(args)
    require(${JSON.stringify(require.resolve('../../src/helpers/bundler-register'))})

    let activations = 0
    let bundlerEvents = 0
    let starts = 0
    const sequence = []
    dc.channel('dd-trace:instrumentation:load').subscribe(({ name }) => {
      if (name !== 'bullmq') return
      activations++
      sequence.push('activation')
    })
    dc.channel('dd-trace:bundler:load').subscribe(() => bundlerEvents++)
    ${tracingSubscription}

    async function run () {
      let Queue
      if (${esm}) {
        const outputPath = path.join(path.dirname(resourcePath), 'output.mjs')
        fs.writeFileSync(outputPath, output)
        ;({ Queue } = await import(pathToFileURL(outputPath).href))
      } else {
        const mod = new Module(resourcePath, module)
        mod.filename = resourcePath
        mod.paths = Module._nodeModulePaths(path.dirname(resourcePath))
        mod._compile(output, resourcePath)
        ;({ Queue } = mod.exports)
      }
      const value = await new Queue().add()
      console.log(JSON.stringify({
        activations,
        bundlerEvents,
        errors: errors.length,
        hasHook: hooks.bullmq !== undefined,
        hasMap: result?.map !== undefined,
        result: value,
        sequence,
        starts,
        warnings: warnings.length,
      }))
    }
    run()
  `)

  const stdout = execFileSync(process.execPath, [mainPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DD_TRACE_DISABLED_INSTRUMENTATIONS: disabled ? 'bullmq' : undefined,
    },
  })
  return JSON.parse(stdout.trim())
}
