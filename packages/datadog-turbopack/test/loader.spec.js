'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')

const sinon = require('sinon')

const loaderPath = require.resolve('../src/loader')
const helperPath = require.resolve('../../datadog-instrumentations/src/helpers/bundler-transform')
const directories = []

describe('Turbopack loader', () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { force: true, recursive: true })
    delete require.cache[loaderPath]
    delete require.cache[helperPath]
    sinon.restore()
  })

  it('passes resolved paths, source maps and bound warnings through instrument', () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'rewrite-package', { type: 'module', version: '4.0.0' })
    const source = 'export function run () {}\n'
    const resourcePath = write(packageDir, 'index.js', source)
    const brokenDir = createPackage(projectDir, 'broken-package', { version: '1.0.0' })
    const brokenSource = 'module.exports = false\n'
    const brokenPath = write(brokenDir, 'index.js', brokenSource)
    fs.writeFileSync(path.join(brokenDir, 'package.json'), '{')
    const sourceMap = { mappings: 'AAAA', version: 3 }
    const outputMap = { mappings: 'BBBB', version: 3 }
    const rewrite = sinon.stub().returns({ code: `${source}// rewritten\n`, map: outputMap })
    const rewriteTarget = { filePath: 'index.js', moduleName: 'rewrite-package' }
    const { loader } = loadLoader({
      hooks: { 'broken-package': sinon.stub(), 'rewrite-package': sinon.stub() },
      instrumentations: {},
      rewrite,
      rewriteTarget: file => file.includes('/rewrite-package/') ? rewriteTarget : undefined,
    })
    const callback = sinon.spy()
    const emitWarning = sinon.spy()
    const context = { callback, emitWarning, resourcePath }

    loader.call(context, source, sourceMap)
    context.resourcePath = brokenPath
    loader.call(context, brokenSource, sourceMap)

    sinon.assert.calledOnceWithExactly(
      rewrite,
      source,
      fs.realpathSync(resourcePath).replaceAll('\\', '/'),
      'module',
      rewriteTarget,
      sourceMap
    )
    sinon.assert.calledTwice(callback)
    assert.equal(callback.firstCall.args[0], undefined)
    assert.match(callback.firstCall.args[1], /\/\/ rewritten/)
    assert.strictEqual(callback.firstCall.args[2], outputMap)
    sinon.assert.calledWithExactly(callback.secondCall, undefined, brokenSource, sourceMap)
    sinon.assert.calledOnceWithExactly(emitWarning, sinon.match.instanceOf(SyntaxError))
    sinon.assert.calledOn(emitWarning, context)
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
    const emitWarning = sinon.spy()
    const missingSource = 'module.exports = false\n'
    const missing = runLoader(
      loader,
      path.join(packageDir, 'missing.__dd_trace_turbopack.js'),
      missingSource,
      undefined,
      emitWarning
    )

    assert.match(result.code, /package: "extensionless-package"/)
    assert.match(result.code, /path: "extensionless-package"/)
    assert.match(result.code, /version: "3\.0\.0"/)
    assert.equal(javascript.code, 'module.exports = true\n')
    assert.equal(marked.code, 'module.exports = "marked"\n')
    assert.equal(missing.code, missingSource)
    assert.equal(missing.sourceMap, undefined)
    sinon.assert.calledOnceWithExactly(emitWarning, sinon.match.has('code', 'ENOENT'))
  })

  it('fails open if the loader context cannot supply a resource path', () => {
    const { loader } = loadLoader({ hooks: {}, instrumentations: {} })
    const failure = new Error('resource path unavailable')
    const source = 'module.exports = true\n'
    const sourceMap = { mappings: 'AAAA', version: 3 }
    const callback = sinon.spy()
    const emitWarning = sinon.spy()

    loader.call({
      callback,
      emitWarning,
      get resourcePath () { throw failure },
    }, source, sourceMap)

    sinon.assert.calledOnceWithExactly(emitWarning, failure)
    sinon.assert.calledOnceWithExactly(callback, undefined, source, sourceMap)
  })
})

/**
 * @param {{
 *   hooks: Record<string, Function|{ fn: Function }>,
 *   instrumentations: Record<string, object[]>,
 *   rewrite?: Function,
 *   rewriteTarget?: (path: string) => object|undefined
 * }} options
 * @returns {{ loader: Function }}
 */
function loadLoader ({
  hooks,
  instrumentations,
  rewrite = sinon.stub().callsFake((source, _path, _format, _target, map) => ({ code: source, map })),
  rewriteTarget = () => undefined,
}) {
  const originalRequire = Module.prototype.require
  Module.prototype.require = function (request) {
    if (this.filename === helperPath) {
      const stubs = {
        './hooks': hooks,
        './instrumentations': instrumentations,
        './rewriter': { createBundlerRewriter: () => rewrite },
        './rewriter/targets': {
          getRewriteTarget: rewriteTarget,
          getRewriteTargetNames: () => Object.keys(hooks).values(),
        },
      }
      if (stubs[request]) return stubs[request]
    }
    return originalRequire.call(this, request)
  }
  delete require.cache[loaderPath]
  delete require.cache[helperPath]
  try {
    return { loader: require('../src/loader') }
  } finally {
    Module.prototype.require = originalRequire
  }
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

function createProject () {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-turbopack-loader-'))
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
