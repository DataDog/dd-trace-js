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
      DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless',
      DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL: undefined,
      DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_POLL_INTERVAL_SECONDS: 30,
      DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_REQUEST_TIMEOUT_SECONDS: 2,
      site: 'datadoghq.com',
      env: 'my env',
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
      config.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE = value

      assert.strictEqual(configurationSource.resolve(config).mode, 'agentless')
    })
  }

  it('defaults to the Datadog UFC CDN endpoint and includes the environment', () => {
    config.DD_SITE = 'raw-env-key.invalid'
    const resolved = configurationSource.resolve(config)

    assert.strictEqual(
      resolved.endpoint.toString(),
      'https://ufc-server.ff-cdn.datadoghq.com/api/v2/feature-flagging/config/rules-based/server?dd_env=my+env'
    )
    assert.strictEqual(resolved.apiKey, 'test-api-key')
    assert.strictEqual(resolved.pollIntervalMs, 30_000)
    assert.strictEqual(resolved.requestTimeoutMs, 2000)
  })

  it('derives the staging UFC CDN endpoint from DD_SITE', () => {
    config.site = 'datad0g.com'
    config.env = 'staging'

    assert.strictEqual(
      configurationSource.resolve(config).endpoint.toString(),
      'https://ufc-server.ff-cdn.datad0g.com/api/v2/feature-flagging/config/rules-based/server?dd_env=staging'
    )
  })

  it('appends the standard path to a configured origin', () => {
    config.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL = 'http://127.0.0.1:8080/'

    const resolved = configurationSource.resolve(config)
    assert.strictEqual(
      resolved.endpoint.toString(),
      'http://127.0.0.1:8080/api/v2/feature-flagging/config/rules-based/server'
    )
  })

  it('preserves an exact configured path and query', () => {
    config.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL = 'https://example.com/custom/ufc?tenant=one'

    assert.strictEqual(
      configurationSource.resolve(config).endpoint.toString(),
      'https://example.com/custom/ufc?tenant=one'
    )
  })

  it('derives the managed GovCloud endpoint without hard-coding availability', () => {
    config.site = 'DDOG-GOV.COM'
    config.env = 'prod'
    const provider = {
      _setConfiguration: sinon.spy(),
      _setConfigurationSource: sinon.spy(),
    }
    const configuration = { flags: {} }

    const resolved = configurationSource.resolve(config)
    configurationSource.enable(config, () => provider)
    AgentlessConfigurationSource.firstCall.args[1](configuration)

    assert.strictEqual(
      resolved.endpoint.toString(),
      'https://ufc-server.ff-cdn.ddog-gov.com/api/v2/feature-flagging/config/rules-based/server?dd_env=prod'
    )
    sinon.assert.calledOnce(AgentlessConfigurationSource)
    sinon.assert.calledWithNew(AgentlessConfigurationSource)
    sinon.assert.calledOnceWithExactly(provider._setConfiguration, configuration)
    sinon.assert.calledOnce(provider._setConfigurationSource)
    sinon.assert.notCalled(log.warn)
  })

  it('allows an operator-owned agentless endpoint on GovCloud', () => {
    config.site = 'ddog-gov.com'
    config.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL =
      'https://flags.example.test/custom/ufc?tenant=test'

    const resolved = configurationSource.resolve(config)

    assert.strictEqual(resolved.endpoint.toString(), 'https://flags.example.test/custom/ufc?tenant=test')
    sinon.assert.notCalled(log.warn)
  })

  it('rejects non-HTTP endpoints', () => {
    config.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL = 'file:///tmp/ufc.json'

    assert.throws(
      () => configurationSource.resolve(config),
      /must use HTTP or HTTPS/
    )
  })

  it('rejects malformed endpoints without enabling a source', () => {
    config.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL = 'not a URL'
    const provider = { _setConfigurationSource: sinon.spy() }

    assert.throws(
      () => configurationSource.resolve(config),
      /Invalid Feature Flagging agentless URL: not a URL/
    )
    configurationSource.enable(config, () => provider)

    sinon.assert.calledOnceWithMatch(
      log.error,
      'Unable to configure Feature Flagging configuration source',
      sinon.match.instanceOf(Error)
    )
    sinon.assert.notCalled(provider._setConfigurationSource)
  })

  it('recognizes explicit Remote Config without resolving agentless settings', () => {
    config.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE = ' REMOTE_CONFIG '
    delete config.site

    assert.deepStrictEqual(configurationSource.resolve(config), { mode: 'remote_config' })
    assert.strictEqual(configurationSource.isRemoteConfig(config), true)
  })

  for (const value of ['offline', 'other']) {
    it(`fails closed for the unsupported ${value} source`, () => {
      config.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE = value

      assert.throws(() => configurationSource.resolve(config), /Unsupported Feature Flagging configuration source/)
      assert.strictEqual(configurationSource.isRemoteConfig(config), false)
      sinon.assert.calledOnce(log.error)
    })
  }

  it('falls back to positive timing defaults with warnings', () => {
    config.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_POLL_INTERVAL_SECONDS = 0
    config.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_REQUEST_TIMEOUT_SECONDS = -1

    assert.strictEqual(configurationSource.isRemoteConfig(config), false)
    sinon.assert.notCalled(log.warn)

    const resolved = configurationSource.resolve(config)

    assert.strictEqual(resolved.pollIntervalMs, 30_000)
    assert.strictEqual(resolved.requestTimeoutMs, 2000)
    sinon.assert.calledTwice(log.warn)
  })

  it('caps the polling interval at one hour', () => {
    config.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_POLL_INTERVAL_SECONDS = 4 * 60 * 60

    const resolved = configurationSource.resolve(config)

    assert.strictEqual(resolved.pollIntervalMs, 60 * 60 * 1000)
    sinon.assert.calledOnceWithExactly(
      log.warn,
      'Feature Flagging agentless %s %s exceeds the maximum of %ss; using %ss',
      'poll interval',
      4 * 60 * 60,
      60 * 60,
      60 * 60
    )
  })
})
