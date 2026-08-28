'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')
const capabilities = require('../../src/remote_config/capabilities')

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
  url: 'https://datadoghq.com',
  timeoutMs: 5000,
  apiKey: 'api-key',
  hostname: 'host',
}

describe('AgentlessRemoteConfigFetcher', () => {
  it('should adapt the libdatadog client to callbacks', async () => {
    const changes = [{ kind: 'remove', path: 'path' }]
    const nativeFetcher = {
      fetchChanges: sinon.stub().resolves(changes),
      setConfigState: sinon.stub(),
      setExtraServices: sinon.stub(),
      setProductCapabilities: sinon.stub().returns(['UNKNOWN']),
    }
    const RemoteConfigFetcher = sinon.stub().returns(nativeFetcher)
    const run = sinon.stub().callsFake((_store, callback) => callback())
    const AgentlessRemoteConfigFetcher = proxyquire('../../src/remote_config/fetcher', {
      '../../../datadog-core': { storage: sinon.stub().returns({ run }) },
      '@datadog/libdatadog': { RemoteConfigFetcher, '@noCallThru': true },
    })
    const fetcher = new AgentlessRemoteConfigFetcher(options)

    assert.deepStrictEqual(await fetch(fetcher), changes)
    sinon.assert.calledOnceWithExactly(RemoteConfigFetcher, options)
    sinon.assert.calledOnceWithExactly(run, { noop: true }, sinon.match.func)

    fetcher.setConfigState('path', 2, '')
    fetcher.setExtraServices(['service'])
    const mask = capabilities.ASM_ACTIVATION | capabilities.APM_TRACING_ENABLE_DYNAMIC_INSTRUMENTATION
    assert.deepStrictEqual(fetcher.setProductCapabilities(['PRODUCT'], encode(mask)), ['UNKNOWN'])
    sinon.assert.calledOnceWithExactly(nativeFetcher.setConfigState, 'path', 2, '')
    sinon.assert.calledOnceWithExactly(nativeFetcher.setExtraServices, ['service'])
    sinon.assert.calledOnceWithExactly(nativeFetcher.setProductCapabilities, ['PRODUCT'], [
      'ASM_ACTIVATION',
      'APM_TRACING_ENABLE_DYNAMIC_INSTRUMENTATION',
    ])
  })

  it('should report rejected fetches through the callback', async () => {
    const expectedError = new Error('request failed')
    const AgentlessRemoteConfigFetcher = createFetcher({
      fetchChanges: sinon.stub().rejects(expectedError),
    })

    await assert.rejects(fetch(new AgentlessRemoteConfigFetcher(options)), expectedError)
  })

  it('should report synchronous fetch failures through the callback', async () => {
    const expectedError = new Error('request failed')
    const AgentlessRemoteConfigFetcher = createFetcher({
      fetchChanges: sinon.stub().throws(expectedError),
    })

    await assert.rejects(fetch(new AgentlessRemoteConfigFetcher(options)), expectedError)
  })
})

/**
 * @param {object} nativeFetcher
 * @returns {import('../../src/remote_config/fetcher')}
 */
function createFetcher (nativeFetcher) {
  return proxyquire('../../src/remote_config/fetcher', {
    '@datadog/libdatadog': {
      RemoteConfigFetcher: sinon.stub().returns(nativeFetcher),
      '@noCallThru': true,
    },
  })
}

/**
 * @param {bigint} mask
 * @returns {string}
 */
function encode (mask) {
  let hex = mask.toString(16)
  if (hex.length % 2) hex = `0${hex}`
  return Buffer.from(hex, 'hex').toString('base64')
}

/**
 * @param {{fetchChanges(callback: (error?: Error, changes?: object[]) => void): void}} fetcher
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
