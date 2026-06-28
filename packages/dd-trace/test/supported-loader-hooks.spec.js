'use strict'

const assert = require('node:assert/strict')
const { afterEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()

require('./setup/core')

/**
 * Loads supported-loader-hooks with a stubbed `version` module so each Node major's
 * threshold can be checked at its boundary without running on that Node.
 *
 * @param {{ NODE_MAJOR: number, NODE_MINOR: number, NODE_PATCH: number }} version
 * @returns {boolean}
 */
function supportedFor (version) {
  const { syncLoaderHooksSupported } = proxyquire('../src/supported-loader-hooks', {
    '../../../version': version,
  })
  return syncLoaderHooksSupported()
}

describe('syncLoaderHooksSupported', () => {
  let originalElectron

  afterEach(() => {
    if (originalElectron === undefined) {
      delete process.versions.electron
    } else {
      process.versions.electron = originalElectron
    }
    originalElectron = undefined
  })

  it('is supported on Node 26 and later', () => {
    assert.strictEqual(supportedFor({ NODE_MAJOR: 26, NODE_MINOR: 0, NODE_PATCH: 0 }), true)
    assert.strictEqual(supportedFor({ NODE_MAJOR: 27, NODE_MINOR: 0, NODE_PATCH: 0 }), true)
  })

  it('is supported on Node 25 only from 25.1.0', () => {
    assert.strictEqual(supportedFor({ NODE_MAJOR: 25, NODE_MINOR: 0, NODE_PATCH: 9 }), false)
    assert.strictEqual(supportedFor({ NODE_MAJOR: 25, NODE_MINOR: 1, NODE_PATCH: 0 }), true)
  })

  it('is supported on Node 24 only from 24.11.1', () => {
    assert.strictEqual(supportedFor({ NODE_MAJOR: 24, NODE_MINOR: 11, NODE_PATCH: 0 }), false)
    assert.strictEqual(supportedFor({ NODE_MAJOR: 24, NODE_MINOR: 11, NODE_PATCH: 1 }), true)
    assert.strictEqual(supportedFor({ NODE_MAJOR: 24, NODE_MINOR: 12, NODE_PATCH: 0 }), true)
  })

  it('is supported on Node 22 only from 22.22.3', () => {
    assert.strictEqual(supportedFor({ NODE_MAJOR: 22, NODE_MINOR: 22, NODE_PATCH: 2 }), false)
    assert.strictEqual(supportedFor({ NODE_MAJOR: 22, NODE_MINOR: 22, NODE_PATCH: 3 }), true)
    assert.strictEqual(supportedFor({ NODE_MAJOR: 22, NODE_MINOR: 23, NODE_PATCH: 0 }), true)
  })

  it('is not supported on Node 23 or older majors below the floor', () => {
    assert.strictEqual(supportedFor({ NODE_MAJOR: 23, NODE_MINOR: 9, NODE_PATCH: 0 }), false)
    assert.strictEqual(supportedFor({ NODE_MAJOR: 21, NODE_MINOR: 0, NODE_PATCH: 0 }), false)
    assert.strictEqual(supportedFor({ NODE_MAJOR: 18, NODE_MINOR: 0, NODE_PATCH: 0 }), false)
  })

  it('is never supported under Electron, even on a supported Node version', () => {
    originalElectron = process.versions.electron
    process.versions.electron = '30.0.0'
    assert.strictEqual(supportedFor({ NODE_MAJOR: 26, NODE_MINOR: 0, NODE_PATCH: 0 }), false)
  })
})
