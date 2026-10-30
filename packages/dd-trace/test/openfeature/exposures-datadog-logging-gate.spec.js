'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const { OpenFeature } = require('@openfeature/server-sdk')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

const FLUSH_CHANNEL = 'ffe:writers:flush'

const holdoutConfiguration = {
  createdAt: '2026-10-23T00:00:00.000Z',
  format: 'ufc-v1',
  environment: { name: 'test' },
  flags: {
    'holdout-flag': {
      key: 'holdout-flag',
      enabled: true,
      variationType: 'BOOLEAN',
      variations: {
        control: { key: 'control', value: false },
      },
      allocations: [
        {
          key: 'holdout-allocation',
          doLog: true,
          splits: [
            {
              variationKey: 'control',
              serialId: 1001,
              shards: [{ salt: 'test-salt', ranges: [{ start: 0, end: 10000 }], totalShards: 10000 }],
              features: [{ key: 'exposure.only', value: 'exposed', destinations: ['EXPOSURE'] }],
            },
          ],
        },
      ],
    },
  },
}

describe('Datadog exposure logging switch', () => {
  let request
  let log
  let openfeatureModule
  let setEventDeliveryStrategy
  let ExposureHook
  let provider

  function enableModule (exposuresDatadogLoggingEnabled) {
    const config = {
      service: 'gate-service',
      url: new URL('http://localhost:8126'),
      debug: false,
      DD_METRICS_OTEL_ENABLED: false,
      featureFlags: {
        DD_FEATURE_FLAGS_EXPOSURES_DATADOG_LOGGING_ENABLED: exposuresDatadogLoggingEnabled,
        DD_FLAGGING_EVALUATION_COUNTS_ENABLED: false,
        DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS: 5000,
      },
    }

    openfeatureModule.enable(config)
    if (exposuresDatadogLoggingEnabled) {
      const [moduleConfig, setWriterEnabled] = setEventDeliveryStrategy.firstCall.args
      setWriterEnabled(true, {
        url: moduleConfig.url,
        basePath: '/evp_proxy/v2',
        headers: {},
      })
    }

    const FlaggingProvider = proxyquire('../../src/openfeature/flagging_provider', {
      './configuration_source': { create: () => undefined },
    })
    provider = new FlaggingProvider({ _config: config }, config)
    provider.setConfiguration(holdoutConfiguration)
    return { config, provider }
  }

  async function evaluateWithCustomerHook (provider, providerName) {
    await OpenFeature.setProviderAndWait(providerName, provider)
    const client = OpenFeature.getClient(providerName)
    const evaluations = []
    client.addHooks(new ExposureHook(evaluation => evaluations.push(evaluation)))

    await client.getBooleanDetails('holdout-flag', true, { targetingKey: 'subject-1' })
    await client.getBooleanDetails('holdout-flag', true, { targetingKey: 'subject-1' })

    return evaluations
  }

  beforeEach(() => {
    request = sinon.stub().yieldsAsync(null, 'OK', 200)
    log = { debug: sinon.spy(), info: sinon.spy(), warn: sinon.spy(), error: sinon.spy() }

    setEventDeliveryStrategy = sinon.stub()
    openfeatureModule = proxyquire('../../src/openfeature', {
      './writers/exposures': proxyquire('../../src/openfeature/writers/exposures', {
        './base': proxyquire('../../src/openfeature/writers/base', {
          '../../exporters/common/request': request,
          '../../log': log,
        }),
        '../../log': log,
      }),
      './writers/util': { setEventDeliveryStrategy },
    })

    ;({ ExposureHook } = proxyquire('../../src/openfeature/exposure-hook', { '../log': log }))
  })

  afterEach(async () => {
    await OpenFeature.clearProviders()
    provider?.onClose?.()
    openfeatureModule.disable()
    sinon.restore()
  })

  it('stops only the Datadog send: the hook keeps the verdict and the cache still records', async () => {
    enableModule(false)

    const evaluations = await evaluateWithCustomerHook(provider, 'gate-off')

    assert.strictEqual(evaluations.length, 2)
    assert.ok(evaluations[0].shouldSend())
    assert.ok(!evaluations[0].isCacheHit())
    assert.ok(evaluations[1].isCacheHit())
    assert.ok(!evaluations[1].shouldSend())

    channel(FLUSH_CHANNEL).publish()
    sinon.assert.notCalled(setEventDeliveryStrategy)
    sinon.assert.notCalled(request)
  })

  it('sends exposures with their EXPOSURE features when the switch is on', async () => {
    enableModule(true)

    const evaluations = await evaluateWithCustomerHook(provider, 'gate-on')
    assert.ok(evaluations[0].shouldSend())

    channel(FLUSH_CHANNEL).publish()
    sinon.assert.calledOnce(request)
    const payload = JSON.parse(request.firstCall.args[0])
    assert.strictEqual(payload.exposures.length, 1)
    assert.deepStrictEqual(payload.exposures[0].features, { 'exposure.only': 'exposed' })
  })
})
