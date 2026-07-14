'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/mocha')

const remapPath = require.resolve('../../src/source-maps/remap')

describe('source map remapping facade', () => {
  let cachedRemapModule
  let directFileSystem
  let remap
  let sourceMaps

  beforeEach(() => {
    cachedRemapModule = require.cache[remapPath]
    directFileSystem = {
      closeSync: () => {},
      fstatSync: () => {},
      openSync: () => {},
      readFileSync: () => {},
      readSync: () => {},
      statSync: () => {},
    }
    sourceMaps = {
      configure: sinon.stub(),
    }
    remap = proxyquire.noPreserveCache()('../../src/source-maps/remap', {
      './file-system': () => ({ ...directFileSystem }),
      './index': sourceMaps,
    })
  })

  afterEach(() => {
    if (cachedRemapModule === undefined) {
      delete require.cache[remapPath]
    } else {
      require.cache[remapPath] = cachedRemapModule
    }
  })

  it('loads Datadog source-map processing on the first exported stack', () => {
    sourceMaps.configure.callsFake(() => {
      /**
       * @param {unknown} stack
       * @returns {string}
       */
      function remapStack (stack) {
        return `mapped ${stack}`
      }
      remap.errorStack = remapStack
    })

    remap.configure('datadog')

    sinon.assert.notCalled(sourceMaps.configure)
    assert.strictEqual(remap.errorStack('stack'), 'mapped stack')
    sinon.assert.calledOnce(sourceMaps.configure)
    assert.strictEqual(sourceMaps.configure.firstCall.args[0], 'datadog')
  })

  it('captures filesystem methods before loading Datadog source-map processing', () => {
    const openSync = directFileSystem.openSync
    remap.configure('datadog')
    directFileSystem.openSync = () => {}

    remap.errorStack('stack')

    const configuredFileSystem = sourceMaps.configure.firstCall.args[1]
    assert.ok(configuredFileSystem)
    assert.strictEqual(configuredFileSystem.openSync, openSync)
  })

  it('returns to the identity path when Datadog processing defers to another owner', () => {
    const location = { file: 'generated.js', line: 1, column: 2 }
    remap.configure('datadog')

    assert.strictEqual(remap.location(location), location)
    assert.strictEqual(remap.location(location), location)
    sinon.assert.calledOnce(sourceMaps.configure)
  })

  it('loads all-mode source-map processing during configuration', () => {
    remap.configure('all')

    sinon.assert.calledOnceWithExactly(sourceMaps.configure, 'all')
  })

  it('keeps off mode on the identity fast path', () => {
    const stack = {}

    remap.configure('off')

    assert.strictEqual(remap.errorStack(stack), stack)
    sinon.assert.notCalled(sourceMaps.configure)
  })
})
