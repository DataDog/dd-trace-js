'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')
const JsRemoteConfigFetcher = require('../../src/remote_config/js_fetcher')

const options = {
  clientId: 'client-id',
  runtimeId: 'runtime-id',
  service: 'service',
  env: 'env',
  appVersion: '1.0.0',
  tags: [],
  processTags: [],
  language: 'node',
  tracerVersion: '1.2.3',
  url: 'http://127.0.0.1:8126',
  timeoutMs: 2000,
}

describe('remote config fetcher selection', () => {
  it('should use the libdatadog client when it is available', () => {
    class WasmFetcher {
      constructor (opts) {
        this.opts = opts
      }
    }
    const setStorage = sinon.spy()
    const load = sinon.stub().returns({ RemoteConfigFetcher: WasmFetcher, setStorage })

    const createFetcher = proxyquire('../../src/remote_config/fetcher', {
      '@datadog/libdatadog': { load },
    })

    const fetcher = createFetcher(options)

    // Handed over directly: the wasm client already satisfies the contract, so there is nothing to
    // adapt between it and `RemoteConfig`.
    sinon.assert.calledOnceWithExactly(load, 'remote_config')
    assert.ok(fetcher instanceof WasmFetcher)
    assert.strictEqual(fetcher.opts, options)

    // Its HTTP has to run in a noop async context, or our own http plugin traces every poll.
    sinon.assert.calledOnce(setStorage)
    assert.strictEqual(typeof setStorage.firstCall.firstArg, 'function')
  })

  it('should fall back to the JS client when libdatadog cannot supply one', () => {
    const log = { debug: sinon.spy() }
    const error = new Error('Could not find a remote-config binary for this platform')

    const createFetcher = proxyquire('../../src/remote_config/fetcher', {
      '@datadog/libdatadog': { load: sinon.stub().throws(error) },
      '../log': log,
    })

    const fetcher = createFetcher(options)

    assert.ok(fetcher instanceof JsRemoteConfigFetcher)
    sinon.assert.calledOnceWithExactly(log.debug, '[RC] Falling back to the JS remote config client', error)
  })
})
