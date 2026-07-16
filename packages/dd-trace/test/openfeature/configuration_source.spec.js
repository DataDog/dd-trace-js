'use strict'

const assert = require('node:assert/strict')
const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

describe('OpenFeature configuration source', () => {
  let config
  let configurationSource
  let log
  let AgentlessConfigurationSource

  beforeEach(() => {
    config = {
      DD_API_KEY: 'test-api-key',
      DD_SITE: 'datadoghq.com',
      env: 'my env',
      experimental: {
        flaggingProvider: {
          configurationSource: 'agentless',
          agentlessBaseUrl: undefined,
          agentlessPollIntervalSeconds: 30,
          agentlessRequestTimeoutSeconds: 2,
        },
      },
    }
    log = {
      debug: sinon.spy(),
      error: sinon.spy(),
      warn: sinon.spy(),
    }
    AgentlessConfigurationSource = sinon.stub()
    configurationSource = proxyquire('../../src/openfeature/configuration_source', {
      '../log': log,
      './agentless_configuration_source': AgentlessConfigurationSource,
    })
  })

  for (const value of [undefined, null, '', '   ', ' AgEnTlEsS ']) {
    it(`normalizes ${JSON.stringify(value)} to the default agentless source`, () => {
      config.experimental.flaggingProvider.configurationSource = value

      assert.strictEqual(configurationSource.resolve(config).mode, 'agentless')
    })
  }

  it('defaults to the Datadog UFC CDN endpoint and includes the environment', () => {
    const resolved = configurationSource.resolve(config)

    assert.strictEqual(
      resolved.endpoint.toString(),
      'https://ufc-server.ff-cdn.datadoghq.com/api/v2/feature-flagging/config/rules-based/server?dd_env=my+env'
    )
    assert.strictEqual(resolved.apiKey, 'test-api-key')
    assert.strictEqual(resolved.allowRawConfiguration, false)
    assert.strictEqual(resolved.pollIntervalMs, 30_000)
    assert.strictEqual(resolved.requestTimeoutMs, 2000)
  })

  it('appends the standard path to a configured origin', () => {
    config.experimental.flaggingProvider.agentlessBaseUrl = 'http://127.0.0.1:8080/'

    const resolved = configurationSource.resolve(config)
    assert.strictEqual(
      resolved.endpoint.toString(),
      'http://127.0.0.1:8080/api/v2/feature-flagging/config/rules-based/server'
    )
    assert.strictEqual(resolved.allowRawConfiguration, true)
  })

  it('preserves an exact configured path and query', () => {
    config.experimental.flaggingProvider.agentlessBaseUrl = 'https://example.com/custom/ufc?tenant=one'

    assert.strictEqual(
      configurationSource.resolve(config).endpoint.toString(),
      'https://example.com/custom/ufc?tenant=one'
    )
  })

  it('allows an explicitly configured HTTP backend', () => {
    config.experimental.flaggingProvider.agentlessBaseUrl = 'http://example.com/custom/ufc'

    assert.strictEqual(
      configurationSource.resolve(config).endpoint.hostname,
      'example.com'
    )
  })

  it('leaves evaluations in default mode for managed agentless delivery on GovCloud', () => {
    config.DD_SITE = 'DDOG-GOV.COM'
    const provider = { _setConfigurationSource: sinon.spy() }

    configurationSource.enable(config, () => provider)

    sinon.assert.notCalled(AgentlessConfigurationSource)
    sinon.assert.notCalled(provider._setConfigurationSource)
    sinon.assert.calledOnceWithExactly(
      log.warn,
      'Datadog-managed Feature Flagging agentless delivery is not supported on GovCloud; evaluations will use defaults'
    )
  })

  it('allows an operator-owned agentless endpoint on GovCloud', () => {
    config.DD_SITE = 'ddog-gov.com'
    config.experimental.flaggingProvider.agentlessBaseUrl = 'https://flags.example.test/custom/ufc?tenant=test'

    const resolved = configurationSource.resolve(config)

    assert.strictEqual(resolved.endpoint.toString(), 'https://flags.example.test/custom/ufc?tenant=test')
    assert.strictEqual(resolved.allowRawConfiguration, true)
    sinon.assert.notCalled(log.warn)
  })

  it('rejects non-HTTP endpoints', () => {
    config.experimental.flaggingProvider.agentlessBaseUrl = 'file:///tmp/ufc.json'

    assert.throws(
      () => configurationSource.resolve(config),
      /must use HTTP or HTTPS/
    )
  })

  it('recognizes explicit Remote Config without resolving agentless settings', () => {
    config.experimental.flaggingProvider.configurationSource = ' REMOTE_CONFIG '
    delete config.DD_SITE

    assert.deepStrictEqual(configurationSource.resolve(config), { mode: 'remote_config' })
    assert.strictEqual(configurationSource.isRemoteConfig(config), true)
  })

  it('reserves offline mode without starting a network source', () => {
    config.experimental.flaggingProvider.configurationSource = 'offline'

    assert.deepStrictEqual(configurationSource.resolve(config), { mode: 'offline' })
  })

  it('fails closed for an unsupported source', () => {
    config.experimental.flaggingProvider.configurationSource = 'other'

    assert.throws(() => configurationSource.resolve(config), /Unsupported Feature Flagging configuration source/)
    assert.strictEqual(configurationSource.isRemoteConfig(config), false)
    sinon.assert.calledOnce(log.error)
  })

  it('falls back to positive timing defaults with warnings', () => {
    config.experimental.flaggingProvider.agentlessPollIntervalSeconds = 0
    config.experimental.flaggingProvider.agentlessRequestTimeoutSeconds = -1

    const resolved = configurationSource.resolve(config)

    assert.strictEqual(resolved.pollIntervalMs, 30_000)
    assert.strictEqual(resolved.requestTimeoutMs, 2000)
    sinon.assert.calledTwice(log.warn)
  })
})
