'use strict'

const assert = require('node:assert/strict')

const { describe, it, afterEach } = require('mocha')

const requireOptionalPeer = require('../../src/helpers/require-optional-peer')

const PEER = '@datadog/openfeature-node-server'

describe('requireOptionalPeer', () => {
  afterEach(() => {
    delete globalThis.__webpack_require__
    delete globalThis.__non_webpack_require__
  })

  it('loads the peer through `require` outside a bundler', () => {
    assert.strictEqual(typeof globalThis.__webpack_require__, 'undefined')

    assert.strictEqual(requireOptionalPeer(PEER), require(PEER))
  })

  it('loads through `__non_webpack_require__`, never `__webpack_require__`, under a bundler', () => {
    const loadCalls = []
    globalThis.__webpack_require__ = () => {
      throw new Error('webpack require must not run for an optional peer')
    }
    globalThis.__non_webpack_require__ = (request) => {
      loadCalls.push(request)
      return require(request)
    }

    const peer = requireOptionalPeer(PEER)

    assert.deepStrictEqual(loadCalls, [PEER])
    assert.strictEqual(peer, require(PEER))
  })

  it('falls back to `require` when `__non_webpack_require__` is absent', () => {
    globalThis.__webpack_require__ = () => {
      throw new Error('webpack require must not run for an optional peer')
    }

    assert.strictEqual(typeof globalThis.__non_webpack_require__, 'undefined')
    assert.strictEqual(requireOptionalPeer(PEER), require(PEER))
  })
})
