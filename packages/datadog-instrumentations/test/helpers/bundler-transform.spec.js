'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')

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
  })

  it('classifies rewrites first while preserving matching CJS publications', () => {
    const projectDir = createProject()
    const cjs = createPackage(projectDir, 'rewrite-package', { main: 'index.js', version: '1.0.0' })
    const esm = createPackage(projectDir, 'esm-rewrite-package', { type: 'module', version: '1.0.0' })
    const source = 'module.exports = true\n'
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
    assert.match(result.code, /\/\/ rewritten/)
    assert.match(result.code, /package: "rewrite-package"/)
    assert.doesNotMatch(result.code, /"activate":true/)
    assert.strictEqual(result.map, sourceMap)
  })

  it('fails open with a warning for unsafe CJS publication and activation', () => {
    const projectDir = createProject()
    const published = createPackage(projectDir, 'published-package', { main: 'index.js', version: '1.0.0' })
    const rewritten = createPackage(projectDir, 'rewritten-package', { version: '1.0.0' })
    const unsafe = 'function require () {}\nmodule.exports = true\n'
    const publishedFile = write(published, 'index.js', unsafe)
    const rewrittenFile = write(rewritten, 'index.js', unsafe)
    const instrumentations = {}
    const hooks = {
      'published-package': () => { instrumentations['published-package'] = [{ versions: ['1'] }] },
      'rewritten-package': () => {},
    }
    const rewriteTarget = resourcePath => resourcePath.includes('/rewritten-package/')
      ? { moduleName: 'rewritten-package', filePath: 'index.js' }
      : undefined
    const rewrite = sinon.stub().returns({ code: `${unsafe}// rewritten\n` })
    const { instrument } = loadHelper({ hooks, instrumentations, rewrite, rewriteTarget })
    const warn = sinon.spy()

    assert.equal(instrument({ source: unsafe, resourcePath: publishedFile, warn }), undefined)
    assert.equal(instrument({ source: unsafe, resourcePath: rewrittenFile, warn }), undefined)
    sinon.assert.calledTwice(warn)
    assert.match(warn.firstCall.args[0].message, /Skipped CommonJS publication for unsafe wrapper bindings/)
    assert.match(warn.secondCall.args[0].message, /Skipped CommonJS activation for unsafe wrapper bindings/)
    sinon.assert.calledOnce(rewrite)
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
 */
function createPackage (projectDir, name, packageJson) {
  const directory = path.join(projectDir, 'node_modules', name)
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
 * @param {{ hooks: object, instrumentations: object, relativePath?: string, rewrite?: Function,
 *   rewriteTarget?: Function, rewriteTargetNames?: string[] }} options
 * @returns {typeof import('../../src/helpers/bundler-transform')}
 */
function loadHelper ({ hooks, instrumentations, relativePath, rewrite, rewriteTarget, rewriteTargetNames }) {
  const originalRequire = Module.prototype.require
  Module.prototype.require = function (request) {
    if (this.filename === helperPath) {
      const stubs = {
        './hooks': hooks,
        './instrumentations': instrumentations,
        './rewriter': { createBundlerRewriter: () => rewrite },
        './rewriter/targets': {
          getRewriteTarget: rewriteTarget ?? (() => undefined),
          getRewriteTargetNames: () => (rewriteTargetNames ?? Object.keys(hooks)).values(),
        },
        'node:path': relativePath ? { ...path, relative: () => relativePath } : path,
      }
      if (stubs[request]) return stubs[request]
    }
    return originalRequire.call(this, request)
  }
  delete require.cache[helperPath]
  try {
    return require('../../src/helpers/bundler-transform')
  } finally {
    Module.prototype.require = originalRequire
  }
}
