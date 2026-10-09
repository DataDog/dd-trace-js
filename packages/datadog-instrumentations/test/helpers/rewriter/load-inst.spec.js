'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')

const { describe, it } = require('mocha')

const { getInstrumentation } = require('../../../../dd-trace/test/setup/helpers/load-inst')
const { getHooks } = require('../../../src/helpers/instrument')

const INSTRUMENTATIONS_PATH = path.resolve(__dirname, '../../../src')
const INSTRUMENT_HELPER_PATH = path.join(INSTRUMENTATIONS_PATH, 'helpers/instrument')

/**
 * @param {string} name
 * @param {string} source
 * @param {(getLoadCount: () => number) => void} callback
 */
function withMockedSourceFile (name, source, callback) {
  const instPath = path.join(INSTRUMENTATIONS_PATH, `${name}.js`)
  const originalExistsSync = fs.existsSync
  const originalLoad = Module._load
  const originalModule = require.cache[instPath]
  let loadCount = 0

  fs.existsSync = function (filePath) {
    if (filePath === instPath) return true
    return originalExistsSync.call(this, filePath)
  }

  Module._load = function (request, parent, isMain) {
    if (request === instPath) {
      if (require.cache[instPath]) return require.cache[instPath].exports
      loadCount++
      const mockedModule = new Module(instPath, parent)
      mockedModule.filename = instPath
      mockedModule.paths = Module._nodeModulePaths(path.dirname(instPath))
      require.cache[instPath] = mockedModule
      mockedModule._compile(source, instPath)
      return mockedModule.exports
    }

    return originalLoad.call(this, request, parent, isMain)
  }

  try {
    return callback(() => loadCount)
  } finally {
    fs.existsSync = originalExistsSync
    Module._load = originalLoad
    if (originalModule) {
      require.cache[instPath] = originalModule
    } else {
      delete require.cache[instPath]
    }
  }
}

describe('setup/helpers/load-inst', () => {
  it('falls back to rewriter hooks when a single-file instrumentation registers no hooks', () => {
    withMockedSourceFile('mercurius', '', () => {
      assert.deepStrictEqual(getInstrumentation('mercurius'), [...getHooks('mercurius').values()])
    })
  })

  it('prefers hooks registered by the single-file instrumentation', () => {
    const hook = { name: 'graphql', versions: ['>=0'], file: 'index.js' }
    const source = `require(${JSON.stringify(INSTRUMENT_HELPER_PATH)}).addHook(${JSON.stringify(hook)})`

    withMockedSourceFile('graphql', source, () => {
      assert.deepStrictEqual(getInstrumentation('graphql'), [hook])
    })
  })

  it('loads subscriber-only instrumentation once across repeated discovery and runtime requires', () => {
    withMockedSourceFile('mercurius', '', getLoadCount => {
      const first = getInstrumentation('mercurius')
      const second = getInstrumentation('mercurius')
      require(path.join(INSTRUMENTATIONS_PATH, 'mercurius.js'))

      assert.deepStrictEqual(first, [...getHooks('mercurius').values()])
      assert.deepStrictEqual(second, first)
      assert.notStrictEqual(second[0], first[0])
      assert.strictEqual(getLoadCount(), 1)
    })
  })

  it('continues to reload files that register hooks on repeated discovery', () => {
    const hook = { name: 'graphql', versions: ['>=0'], file: 'index.js' }
    const source = `require(${JSON.stringify(INSTRUMENT_HELPER_PATH)}).addHook(${JSON.stringify(hook)})`

    withMockedSourceFile('graphql', source, getLoadCount => {
      assert.deepStrictEqual(getInstrumentation('graphql'), [hook])
      assert.deepStrictEqual(getInstrumentation('graphql'), [hook])
      assert.strictEqual(getLoadCount(), 2)
    })
  })

  it('keeps an empty result when no rewriter instrumentation exists', () => {
    withMockedSourceFile('load-inst-empty-without-rewriter', '', () => {
      assert.deepStrictEqual(getInstrumentation('load-inst-empty-without-rewriter'), [])
    })
  })

  it('continues to load pure rewriter instrumentations', () => {
    assert.deepStrictEqual(getInstrumentation('mercurius'), [...getHooks('mercurius').values()])
  })
})
