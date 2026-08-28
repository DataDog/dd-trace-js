'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

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
  it('should use the JS client for the Agent protocol', () => {
    const RemoteConfigFetcher = sinon.stub()
    const createFetcher = proxyquire('../../src/remote_config/fetcher', {
      '@datadog/libdatadog': { RemoteConfigFetcher, '@noCallThru': true },
    })

    const fetcher = createFetcher(options)

    assert.ok(fetcher instanceof JsRemoteConfigFetcher)
    sinon.assert.notCalled(RemoteConfigFetcher)
  })

  it('should adapt the libdatadog client for agentless Remote Config', async () => {
    const changes = [{ kind: 'remove', path: 'path' }]
    const nativeFetcher = {
      fetchChanges: sinon.stub().resolves(changes),
      setConfigState: sinon.stub(),
      setExtraServices: sinon.stub(),
      setProductCapabilities: sinon.stub().returns(['UNKNOWN']),
    }
    let constructorOptions
    function RemoteConfigFetcher (opts) {
      constructorOptions = opts
      return nativeFetcher
    }
    const run = sinon.stub().callsFake((_store, callback) => callback())
    const agentlessOptions = {
      ...options,
      agentless: true,
      apiKey: 'api-key',
      hostname: 'host',
    }

    const createFetcher = proxyquire('../../src/remote_config/fetcher', {
      '../../../datadog-core': { storage: sinon.stub().returns({ run }) },
      '@datadog/libdatadog': { RemoteConfigFetcher, '@noCallThru': true },
    })
    const fetcher = createFetcher(agentlessOptions)

    assert.deepStrictEqual(constructorOptions, {
      ...options,
      apiKey: 'api-key',
      hostname: 'host',
    })
    assert.deepStrictEqual(await fetch(fetcher), changes)
    sinon.assert.calledOnceWithExactly(run, { noop: true }, sinon.match.func)

    fetcher.setConfigState('path', 2, '')
    fetcher.setExtraServices(['service'])
    assert.deepStrictEqual(fetcher.setProductCapabilities(['PRODUCT'], ['CAPABILITY']), ['UNKNOWN'])
    sinon.assert.calledOnceWithExactly(nativeFetcher.setConfigState, 'path', 2, '')
    sinon.assert.calledOnceWithExactly(nativeFetcher.setExtraServices, ['service'])
    sinon.assert.calledOnceWithExactly(nativeFetcher.setProductCapabilities, ['PRODUCT'], ['CAPABILITY'])
  })

  it('should report libdatadog fetch failures through the callback', async () => {
    const expectedError = new Error('request failed')
    const RemoteConfigFetcher = sinon.stub().returns({
      fetchChanges: sinon.stub().rejects(expectedError),
    })
    const createFetcher = proxyquire('../../src/remote_config/fetcher', {
      '@datadog/libdatadog': { RemoteConfigFetcher, '@noCallThru': true },
    })

    await assert.rejects(fetch(createFetcher({ ...options, agentless: true })), expectedError)
  })

  it('should report synchronous libdatadog fetch failures through the callback', async () => {
    const expectedError = new Error('request failed')
    const RemoteConfigFetcher = sinon.stub().returns({
      fetchChanges: sinon.stub().throws(expectedError),
    })
    const createFetcher = proxyquire('../../src/remote_config/fetcher', {
      '@datadog/libdatadog': { RemoteConfigFetcher, '@noCallThru': true },
    })

    await assert.rejects(fetch(createFetcher({ ...options, agentless: true })), expectedError)
  })

  it('should not use the Agent protocol when the agentless client cannot start', () => {
    const expectedError = new Error('agentless Remote Config is unavailable')
    const RemoteConfigFetcher = sinon.stub().throws(expectedError)
    const createFetcher = proxyquire('../../src/remote_config/fetcher', {
      '@datadog/libdatadog': { RemoteConfigFetcher, '@noCallThru': true },
    })

    assert.throws(() => createFetcher({ ...options, agentless: true }), expectedError)
  })
})

/**
 * @param {{fetchChanges(callback: (error: Error|null, changes?: object[]) => void): void}} fetcher
 * @returns {Promise<object[]>}
 */
function fetch (fetcher) {
  return new Promise((resolve, reject) => {
    fetcher.fetchChanges((error, changes) => {
      if (error) {
        reject(error)
      } else {
        resolve(changes)
      }
    })
  })
}
