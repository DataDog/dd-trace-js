'use strict'

const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

const lineCoveragePath = require.resolve('../../src/ci-visibility/line-coverage')

describe('line coverage enable', () => {
  const originalCompile = Module.prototype._compile
  const root = path.resolve(__dirname, '../../../..')

  function loadFresh () {
    delete require.cache[lineCoveragePath]
    return require(lineCoveragePath)
  }

  afterEach(() => {
    Module.prototype._compile = originalCompile
    delete require.cache[lineCoveragePath]
  })

  it('compiles modules of the root through the instrumenter by default', () => {
    const lineCoverage = loadFresh()
    lineCoverage.enable({ root })

    assert.notStrictEqual(Module.prototype._compile, originalCompile)
    assert.strictEqual(lineCoverage.isActive(), true)
  })

  it('leaves Node.js module loader alone when asked to', () => {
    const lineCoverage = loadFresh()
    lineCoverage.enable({ root, patchModuleLoader: false })

    assert.strictEqual(Module.prototype._compile, originalCompile)
    assert.strictEqual(lineCoverage.isActive(), true)
    assert.strictEqual(lineCoverage.shouldInstrument(path.join(root, 'packages/dd-trace/src/id.js')), true)
    assert.strictEqual(lineCoverage.shouldInstrument(path.join(root, 'node_modules/x/index.js')), false)
  })

  it('does not instrument anything before it is enabled', () => {
    const lineCoverage = loadFresh()

    assert.strictEqual(lineCoverage.isActive(), false)
  })
})
