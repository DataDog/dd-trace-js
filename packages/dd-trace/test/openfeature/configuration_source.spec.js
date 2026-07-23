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
      featureFlags: {
        DD_FEATURE_FLAGS_ENABLED: true,
        DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless',
        DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL: undefined,
        DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_POLL_INTERVAL_SECONDS: 30,
        DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_REQUEST_TIMEOUT_SECONDS: 5,
      },
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

  function createSourceConfig () {
    configurationSource.create(config, sinon.spy())
    return AgentlessConfigurationSource.firstCall.args[0]
  }

  it('defaults to the Datadog UFC CDN endpoint and includes the environment', () => {
    config.DD_SITE = 'raw-env-key.invalid'
    const resolved = createSourceConfig()

    assert.strictEqual(
      resolved.endpoint.toString(),
      'https://ufc-server.ff-cdn.datadoghq.com/api/v2/feature-flagging/config/rules-based/server?dd_env=my+env'
    )
    assert.strictEqual(resolved.apiKey, 'test-api-key')
    assert.strictEqual(resolved.pollIntervalMs, 30_000)
    assert.strictEqual(resolved.requestTimeoutMs, 5000)
  })

  it('derives the staging UFC CDN endpoint from DD_SITE', () => {
    config.site = 'datad0g.com'
    config.env = 'staging'

    assert.strictEqual(
      createSourceConfig().endpoint.toString(),
      'https://ufc-server.ff-cdn.datad0g.com/api/v2/feature-flagging/config/rules-based/server?dd_env=staging'
    )
  })

  it('caps the polling interval at one hour', () => {
    config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_POLL_INTERVAL_SECONDS = 4 * 60 * 60

    assert.strictEqual(createSourceConfig().pollIntervalMs, 60 * 60 * 1000)
  })

  it('appends the standard path to a configured origin', () => {
    config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL = 'http://127.0.0.1:8080/'

    const resolved = createSourceConfig()
    assert.strictEqual(
      resolved.endpoint.toString(),
      'http://127.0.0.1:8080/api/v2/feature-flagging/config/rules-based/server'
    )
  })

  for (const baseUrl of ['http://localhost:8080', 'http://127.1.2.3:8080', 'http://[::1]:8080']) {
    it(`allows the loopback endpoint ${baseUrl}`, () => {
      config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL = baseUrl

      const resolved = createSourceConfig()
      assert.strictEqual(
        resolved.endpoint.toString(),
        `${baseUrl}/api/v2/feature-flagging/config/rules-based/server`
      )
      assert.strictEqual(resolved.apiKey, undefined)
    })
  }

  it('allows a cleartext custom endpoint for local development and proxies', () => {
    config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL =
      'http://flags.dev.internal:8080'

    const resolved = createSourceConfig()
    assert.strictEqual(
      resolved.endpoint.toString(),
      'http://flags.dev.internal:8080/api/v2/feature-flagging/config/rules-based/server'
    )
    assert.strictEqual(resolved.apiKey, undefined)
  })

  it('preserves an exact configured path and query', () => {
    config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL =
      'https://example.com/custom/ufc?tenant=one'

    const resolved = createSourceConfig()
    assert.strictEqual(
      resolved.endpoint.toString(),
      'https://example.com/custom/ufc?tenant=one'
    )
    assert.strictEqual(resolved.apiKey, undefined)
  })

  it('derives and creates the managed GovCloud endpoint without hard-coding availability', () => {
    config.site = 'DDOG-GOV.COM'
    config.env = 'prod'
    const applyConfiguration = sinon.spy()

    const source = configurationSource.create(config, applyConfiguration)
    const resolved = AgentlessConfigurationSource.firstCall.args[0]

    assert.strictEqual(
      resolved.endpoint.toString(),
      'https://ufc-server.ff-cdn.ddog-gov.com/api/v2/feature-flagging/config/rules-based/server?dd_env=prod'
    )
    sinon.assert.calledOnce(AgentlessConfigurationSource)
    sinon.assert.calledWithNew(AgentlessConfigurationSource)
    sinon.assert.calledOnceWithExactly(
      AgentlessConfigurationSource,
      sinon.match({
        endpoint: resolved.endpoint,
        apiKey: 'test-api-key',
        pollIntervalMs: 30_000,
        requestTimeoutMs: 5000,
      }),
      applyConfiguration
    )
    assert.ok(source instanceof AgentlessConfigurationSource)
    sinon.assert.notCalled(log.warn)
  })

  it('allows an operator-owned agentless endpoint on GovCloud', () => {
    config.site = 'ddog-gov.com'
    config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL =
      'https://flags.example.test/custom/ufc?tenant=test'

    const resolved = createSourceConfig()

    assert.strictEqual(resolved.endpoint.toString(), 'https://flags.example.test/custom/ufc?tenant=test')
    sinon.assert.notCalled(log.warn)
  })

  it('rejects non-HTTP endpoints', () => {
    config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL = 'file:///tmp/ufc.json'

    const source = configurationSource.create(config, sinon.spy())

    assert.strictEqual(source, undefined)
    sinon.assert.calledOnceWithMatch(
      log.error,
      'Unable to configure Feature Flagging configuration source',
      sinon.match.instanceOf(Error)
    )
    sinon.assert.notCalled(AgentlessConfigurationSource)
  })

  it('rejects malformed endpoints without logging their sensitive value', () => {
    const sentinel = 'sensitive-value'
    config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL = `https://${sentinel} value`

    const source = configurationSource.create(config, sinon.spy())

    sinon.assert.calledOnceWithMatch(
      log.error,
      'Unable to configure Feature Flagging configuration source',
      sinon.match.instanceOf(Error)
    )
    assert.strictEqual(source, undefined)
    sinon.assert.notCalled(AgentlessConfigurationSource)
    assert.doesNotMatch(log.error.firstCall.args[1].message, new RegExp(sentinel))
    assert.strictEqual(log.error.firstCall.args[1].cause, undefined)
  })

  it('creates a source for a custom API without a Datadog API key', () => {
    delete config.DD_API_KEY
    config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL =
      'https://flags.example.test/custom/ufc'

    const source = configurationSource.create(config, sinon.spy())

    assert.ok(source instanceof AgentlessConfigurationSource)
    assert.strictEqual(AgentlessConfigurationSource.firstCall.args[0].apiKey, undefined)
    sinon.assert.notCalled(log.error)
  })

  it('requires a Datadog API key for the default Datadog API', () => {
    delete config.DD_API_KEY

    const source = configurationSource.create(config, sinon.spy())

    sinon.assert.calledOnceWithMatch(
      log.error,
      'Unable to configure Feature Flagging configuration source',
      sinon.match.has('message', 'DD_API_KEY is required for the Datadog Feature Flagging API')
    )
    assert.strictEqual(source, undefined)
    sinon.assert.notCalled(AgentlessConfigurationSource)
  })

  it('does not create an agentless source for Remote Config delivery', () => {
    config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE = 'remote_config'
    delete config.site

    const source = configurationSource.create(config, sinon.spy())

    assert.strictEqual(source, undefined)
    sinon.assert.notCalled(AgentlessConfigurationSource)
  })

  it('does not create an agentless source when Feature Flags are disabled', () => {
    config.featureFlags.DD_FEATURE_FLAGS_ENABLED = false
    delete config.site

    const source = configurationSource.create(config, sinon.spy())

    assert.strictEqual(source, undefined)
    sinon.assert.notCalled(AgentlessConfigurationSource)
  })
})
