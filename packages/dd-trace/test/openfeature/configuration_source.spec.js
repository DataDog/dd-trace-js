'use strict'

const assert = require('node:assert/strict')
const { afterEach, beforeEach, describe, it } = require('mocha')
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

  it('uses shared site normalization for the managed UFC endpoint', () => {
    config.site = '  MOCK-INTAKE.INVALID  '

    assert.strictEqual(
      createSourceConfig().endpoint.toString(),
      'https://ufc-server.ff-cdn.mock-intake.invalid/api/v2/feature-flagging/config/rules-based/server?dd_env=my+env'
    )
  })

  it('rejects an invalid managed site without including its value', () => {
    config.site = 'sensitive\\invalid.example'

    assert.throws(
      () => configurationSource.create(config, sinon.spy()),
      { message: 'Invalid DD_SITE for Feature Flagging agentless configuration' }
    )
    sinon.assert.notCalled(AgentlessConfigurationSource)
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

  it('logs only the origin, dropping credentials, path, and query, when starting the agentless source', () => {
    config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL =
      'https://user:tok@example.com/signed-token-in-path/ufc?sig=super-secret-value'

    createSourceConfig()

    sinon.assert.calledOnceWithExactly(
      log.debug,
      'Feature Flags: starting agentless configuration source at %s ' +
      '(%s endpoint, poll interval %ds, request timeout %ds, DD-API-KEY header %s)',
      'https://example.com',
      'custom',
      30,
      5,
      'not sent'
    )
  })

  it('logs the effective agentless settings for the default endpoint', () => {
    config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_POLL_INTERVAL_SECONDS = 7200

    createSourceConfig()

    sinon.assert.calledOnceWithExactly(
      log.debug,
      'Feature Flags: starting agentless configuration source at %s ' +
      '(%s endpoint, poll interval %ds, request timeout %ds, DD-API-KEY header %s)',
      'https://ufc-server.ff-cdn.datadoghq.com',
      'default',
      3600,
      5,
      'sent'
    )
    assert.doesNotMatch(JSON.stringify(log.debug.firstCall.args), /test-api-key/)
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

    assert.throws(
      () => configurationSource.create(config, sinon.spy()),
      { message: 'Feature Flagging agentless URL must use HTTP or HTTPS' }
    )
    sinon.assert.notCalled(AgentlessConfigurationSource)
  })

  it('rejects malformed endpoints without including their sensitive value', () => {
    const sentinel = 'sensitive-value'
    config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL = `https://${sentinel} value`

    assert.throws(
      () => configurationSource.create(config, sinon.spy()),
      error => {
        assert.strictEqual(error.message, 'Invalid Feature Flagging agentless URL')
        assert.strictEqual(error.cause, undefined)
        return true
      }
    )
    sinon.assert.notCalled(AgentlessConfigurationSource)
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

  it('passes the tracer service so the CDN can attribute usage to it', () => {
    config.service = 'checkout'

    assert.strictEqual(createSourceConfig().service, 'checkout')
  })

  it('passes the service to a custom endpoint, unlike the API key', () => {
    config.service = 'checkout'
    config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL =
      'https://flags.example.test/custom/ufc'

    const resolved = createSourceConfig()

    assert.strictEqual(resolved.service, 'checkout')
    assert.strictEqual(resolved.apiKey, undefined)
  })

  // Expected DD-Service values. They come from the Agent NormalizeService (datadog-agent
  // pkg/trace/traceutil/normalize v0.82.3) and the CDN format check. `undefined` means: no DD-Service header.
  const APM_SERVICE_NAMES = [
    ['checkout', 'checkout'],
    ['My Service', 'my_service'],
    ['My-API', 'my-api'],
    ['UPPER', 'upper'],
    ['bad\nvalue', 'bad_value'],
    ['a\tb', 'a_b'],
    ['a  b!', 'a_b'],
    ['svc ', 'svc'],
    [' svc', undefined],
    ['a_', 'a'],
    ['svc-', 'svc-'],
    ['a..b', 'a..b'],
    ['2fa-service', '2fa-service'],
    ['9lives', '9lives'],
    ['unnamed-service', 'unnamed-service'],
    ['svc_name.v2:api/edge-1', 'svc_name.v2:api/edge-1'],
    ['my__service', 'my_service'],
    ['Default Web Site/Shop', 'default_web_site/shop'],
    [`a${'b'.repeat(99)}`, `a${'b'.repeat(99)}`],
    [`a${'b'.repeat(100)}`, `a${'b'.repeat(99)}`],
    [`${'a'.repeat(100)} b`, 'a'.repeat(100)],
    [`${'a'.repeat(99)}é`, 'a'.repeat(99)],
    ['_svc', undefined],
    ['-svc', undefined],
    ['.svc', undefined],
    [':svc', undefined],
    ['café-api', undefined],
    ['Café', undefined],
    ['支付', undefined],
    ['a🐶b', 'a_b'],
    ['İstanbul', undefined],
    ['é'.repeat(60), undefined],
    ['___', undefined],
    ['-', undefined],
    ['', undefined],
    ['   ', undefined],
  ]

  it('passes the name APM shows for the service, or none when the CDN would drop that name', () => {
    for (const [service, sent] of APM_SERVICE_NAMES) {
      AgentlessConfigurationSource.resetHistory()
      config.service = service

      assert.strictEqual(createSourceConfig().service, sent, JSON.stringify(service))
    }
  })

  it('derives only the service it sends, not the tracer service', () => {
    config.service = 'My Service'

    assert.strictEqual(createSourceConfig().service, 'my_service')
    assert.strictEqual(config.service, 'My Service')
  })

  // A different name attributes the usage to a service that APM does not show.
  it('does not pass a service whose APM name the CDN would drop', () => {
    for (const service of ['_svc', 'café-api', '支付', '___']) {
      AgentlessConfigurationSource.resetHistory()
      log.debug.resetHistory()
      config.service = service

      assert.strictEqual(createSourceConfig().service, undefined, service)
      sinon.assert.calledWithExactly(
        log.debug,
        'Feature Flags: service %s has no APM name the CDN can attribute usage to; DD-Service header not sent',
        service
      )
    }
  })

  it('does not pass an empty service', () => {
    config.service = ''

    assert.strictEqual(createSourceConfig().service, undefined)
    sinon.assert.calledOnce(log.debug)
  })

  describe('with the agentless source polling', () => {
    let clock
    let requests
    let source

    beforeEach(() => {
      clock = sinon.useFakeTimers()
      requests = []
      const RealAgentlessConfigurationSource = proxyquire('../../src/openfeature/agentless_configuration_source', {
        '../exporters/common/request': (data, options) => { requests.push(options) },
        '../log': log,
      })
      configurationSource = proxyquire('../../src/openfeature/configuration_source', {
        '../log': log,
        './agentless_configuration_source': RealAgentlessConfigurationSource,
      })
    })

    afterEach(() => {
      source?.stop()
      clock.restore()
    })

    async function firstRequestHeaders () {
      source = configurationSource.create(config, sinon.spy())
      source.start()
      for (let i = 0; i < 10; i++) await clock.tickAsync(0)
      assert.strictEqual(requests.length, 1)
      return requests[0].headers
    }

    it('sends the name APM shows for the service in DD-Service', async () => {
      config.service = 'My Service'

      assert.strictEqual((await firstRequestHeaders())['DD-Service'], 'my_service')
    })

    it('still polls, without DD-Service, when the CDN would drop the APM name of the service', async () => {
      for (const service of ['_svc', 'café-api', '支付']) {
        source?.stop()
        requests = []
        config.service = service

        assert.strictEqual(Object.hasOwn(await firstRequestHeaders(), 'DD-Service'), false, service)
      }
    })
  })

  for (const apiKey of [undefined, '', '   ']) {
    it(`requires a Datadog API key for the default endpoint (DD_API_KEY=${JSON.stringify(apiKey)})`, () => {
      config.DD_API_KEY = apiKey

      assert.throws(
        () => configurationSource.create(config, sinon.spy()),
        {
          message: 'DD_API_KEY is required for the default Datadog Feature Flagging endpoint; ' +
            'set DD_API_KEY, set DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL, or set ' +
            'DD_FEATURE_FLAGS_CONFIGURATION_SOURCE=remote_config to load flags through the Datadog Agent',
        }
      )
      sinon.assert.notCalled(AgentlessConfigurationSource)
      sinon.assert.notCalled(log.debug)
    })
  }

  it('requires a Datadog API key when the custom endpoint is blank', () => {
    delete config.DD_API_KEY
    config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE_AGENTLESS_BASE_URL = '   '

    assert.throws(() => configurationSource.create(config, sinon.spy()), { message: /^DD_API_KEY is required/ })
    sinon.assert.notCalled(AgentlessConfigurationSource)
  })

  it('does not require a Datadog API key for Remote Config delivery', () => {
    delete config.DD_API_KEY
    config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE = 'remote_config'
    config.remoteConfig = { DD_REMOTE_CONFIGURATION_ENABLED: true }

    assert.strictEqual(configurationSource.create(config, sinon.spy()), undefined)
    sinon.assert.notCalled(AgentlessConfigurationSource)
    sinon.assert.notCalled(log.error)
  })

  it('does not create an agentless source for Remote Config delivery', () => {
    config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE = 'remote_config'
    delete config.site

    const source = configurationSource.create(config, sinon.spy())

    assert.strictEqual(source, undefined)
    sinon.assert.notCalled(AgentlessConfigurationSource)
  })

  it('warns when Remote Config delivery is selected but Remote Configuration is disabled', () => {
    config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE = 'remote_config'
    config.remoteConfig = { DD_REMOTE_CONFIGURATION_ENABLED: false }

    configurationSource.create(config, sinon.spy())

    sinon.assert.calledOnceWithMatch(log.warn, /Remote Configuration is disabled.*DD_REMOTE_CONFIGURATION_ENABLED=true/)

    log.warn.resetHistory()
    config.remoteConfig.DD_REMOTE_CONFIGURATION_ENABLED = true
    configurationSource.create(config, sinon.spy())

    sinon.assert.notCalled(log.warn)
  })

  for (const source of ['offline', 'invalid']) {
    it(`does not create a source for the unsupported ${source} source`, () => {
      config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE = source

      const resolved = configurationSource.create(config, sinon.spy())

      assert.strictEqual(resolved, undefined)
      sinon.assert.notCalled(AgentlessConfigurationSource)
      sinon.assert.notCalled(log.error)
    })
  }

  it('does not create an agentless source when Feature Flags are disabled', () => {
    config.featureFlags.DD_FEATURE_FLAGS_ENABLED = false
    delete config.site

    const source = configurationSource.create(config, sinon.spy())

    assert.strictEqual(source, undefined)
    sinon.assert.notCalled(AgentlessConfigurationSource)
  })
})
