'use strict'

const assert = require('node:assert/strict')

const { ErrorCode, OpenFeature, ProviderEvents, ServerProviderStatus, StandardResolutionReasons } =
  require('@openfeature/server-sdk')
const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')
const log = require('../../src/log')
const { EXPOSURE_CHANNEL } = require('../../src/openfeature/constants/constants')
const { enable } = require('../../src/openfeature/remote_config')
const RemoteConfig = require('../../src/remote_config')

// Keep the bundled evaluator real; only bypass configuration discovery.
const FlaggingProvider = proxyquire('../../src/openfeature/flagging_provider', {
  './configuration_source': { create: () => undefined },
})

/** @param {boolean} [consent] */
function configuration (consent = false) {
  return {
    createdAt: '2026-01-01T00:00:00Z',
    format: 'SERVER',
    environment: { name: 'test' },
    observeFullEvaluationData: consent,
    flags: {
      flag: {
        key: 'flag',
        enabled: true,
        variationType: 'BOOLEAN',
        variations: { on: { key: 'on', value: true } },
        allocations: [{ key: 'all', doLog: false, splits: [{ variationKey: 'on', shards: [] }] }],
      },
    },
  }
}

/**
 * @param {string} operator
 * @param {unknown} value
 */
function ruleConfiguration (operator, value) {
  return {
    ...configuration(),
    flags: {
      flag: {
        key: 'flag',
        enabled: true,
        variationType: 'BOOLEAN',
        variations: { on: { key: 'on', value: true }, off: { key: 'off', value: false } },
        allocations: [
          {
            key: 'rule',
            doLog: false,
            rules: [{ conditions: [{ attribute: 'attr', operator, value }] }],
            splits: [{ variationKey: 'on', shards: [] }],
          },
          { key: 'default', doLog: false, splits: [{ variationKey: 'off', shards: [] }] },
        ],
      },
    },
  }
}

describe('bundled flagging provider smoke tests', () => {
  let provider
  let clock

  beforeEach(() => {
    clock = sinon.useFakeTimers({ now: 1_790_150_400_000 })
    provider = new FlaggingProvider({}, {
      service: 'provider-compatibility',
      featureFlags: {
        // These tests exercise the evaluator, not EVP route discovery or delivery.
        DD_FLAGGING_EVALUATION_COUNTS_ENABLED: false,
        DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS: 30000,
        DD_EXPERIMENTAL_FLAGGING_PROVIDER_SPAN_ENRICHMENT_ENABLED: false,
      },
    })
  })

  afterEach(() => {
    provider.onClose()
    clock.restore()
  })

  it('evaluates a flag through the bundled provider', async () => {
    provider.setConfiguration(configuration())
    const details = await provider.resolveBooleanEvaluation('flag', false, { targetingKey: 'user' }, log)
    assert.strictEqual(details.value, true)
    assert.strictEqual(details.variant, 'on')
    assert.strictEqual(details.reason, 'STATIC')
    assert.strictEqual(details.errorCode, undefined)
  })

  describe('OpenFeature lifecycle', () => {
    let client
    let exposures
    let updateConfiguration

    beforeEach(() => {
      client = OpenFeature.getClient('bundled-provider-lifecycle')
      exposures = sinon.spy()
      channel(EXPOSURE_CHANNEL).subscribe(exposures)
      const rc = sinon.createStubInstance(RemoteConfig)
      enable(rc, () => provider, true)
      sinon.assert.calledOnceWithExactly(rc.setProductHandler, 'FFE_FLAGS', sinon.match.func)
      updateConfiguration = rc.setProductHandler.firstCall.args[1]
    })

    afterEach(async () => {
      await OpenFeature.clearProviders()
      channel(EXPOSURE_CHANNEL).unsubscribe(exposures)
    })

    for (const source of ['null', 'undefined', 'Remote Config unapply']) {
      it(`returns defaults on ${source} and recovers with a fresh exposure`, async () => {
        const selected = configuration()
        selected.flags.flag.allocations[0].doLog = true
        const initialized = OpenFeature.setProviderAndWait('bundled-provider-lifecycle', provider)
        updateConfiguration('apply', selected)
        await initialized

        const context = { targetingKey: 'withdrawal-user' }
        const before = await client.getBooleanDetails('flag', false, context)
        assert.strictEqual(before.value, true)
        assert.strictEqual(before.errorCode, undefined)
        await client.getBooleanDetails('flag', false, context)
        sinon.assert.calledOnce(exposures)

        const observations = []
        client.addHandler(ProviderEvents.Error, () => {
          observations.push({ configuration: provider.getConfiguration(), status: client.providerStatus })
        })
        const ready = sinon.spy()
        const changed = sinon.spy()
        client.addHandler(ProviderEvents.Ready, ready)
        client.addHandler(ProviderEvents.ConfigurationChanged, changed)
        ready.resetHistory()

        for (let i = 0; i < 2; i++) {
          if (source === 'Remote Config unapply') updateConfiguration('unapply', selected)
          else provider.setConfiguration(source === 'null' ? null : undefined)
        }

        assert.strictEqual(provider.getConfiguration(), undefined)
        assert.strictEqual(client.providerStatus, ServerProviderStatus.ERROR)
        assert.deepStrictEqual(observations, [{ configuration: undefined, status: ServerProviderStatus.ERROR }])
        sinon.assert.notCalled(changed)
        sinon.assert.notCalled(ready)
        const unavailable = await client.getBooleanDetails('flag', false, context)
        assert.strictEqual(unavailable.value, false)
        assert.strictEqual(unavailable.reason, StandardResolutionReasons.ERROR)
        assert.strictEqual(unavailable.errorCode, ErrorCode.PROVIDER_NOT_READY)
        sinon.assert.calledOnce(exposures)

        updateConfiguration('apply', selected)
        assert.strictEqual(client.providerStatus, ServerProviderStatus.READY)
        sinon.assert.calledOnce(ready)
        const recovered = await client.getBooleanDetails('flag', false, context)
        assert.strictEqual(recovered.value, true)
        assert.strictEqual(recovered.errorCode, undefined)
        sinon.assert.calledTwice(exposures)
      })
    }

    it('keeps initialization pending after Remote Config unapply before the first configuration', async () => {
      const initialized = OpenFeature.setProviderAndWait('bundled-provider-lifecycle', provider)
      const ready = sinon.spy()
      client.addHandler(ProviderEvents.Ready, ready)

      updateConfiguration('unapply')
      await clock.tickAsync(0)
      assert.strictEqual(client.providerStatus, ServerProviderStatus.NOT_READY)
      sinon.assert.notCalled(ready)

      updateConfiguration('apply', configuration())
      await initialized
      assert.strictEqual(client.providerStatus, ServerProviderStatus.READY)
      sinon.assert.calledOnce(ready)
    })

    it('rejects initialization when the first configuration is withdrawn before it settles', async () => {
      const rejection = assert.rejects(OpenFeature.setProviderAndWait('bundled-provider-lifecycle', provider), {
        name: 'Error', message: 'Flag configuration is unavailable',
      })
      const ready = sinon.spy()
      client.addHandler(ProviderEvents.Ready, ready)

      updateConfiguration('apply', configuration())
      updateConfiguration('unapply')
      await rejection
      assert.strictEqual(client.providerStatus, ServerProviderStatus.ERROR)
      sinon.assert.notCalled(ready)

      updateConfiguration('apply', configuration())
      assert.strictEqual(client.providerStatus, ServerProviderStatus.READY)
      sinon.assert.calledOnce(ready)
    })

    it('exposes the replacement configuration before configuration-change handlers evaluate flags', async () => {
      updateConfiguration('apply', configuration())
      await OpenFeature.setProviderAndWait('bundled-provider-lifecycle', provider)
      const replacement = { ...configuration(), flags: {} }
      let observedConfiguration
      const changed = sinon.spy(() => {
        observedConfiguration = provider.getConfiguration()
        return client.getBooleanDetails('flag', false, { targetingKey: 'replacement-user' })
      })
      client.addHandler(ProviderEvents.ConfigurationChanged, changed)

      updateConfiguration('modify', replacement)

      sinon.assert.calledOnce(changed)
      assert.strictEqual(observedConfiguration, replacement)
      const details = await changed.firstCall.returnValue
      assert.strictEqual(details.value, false)
      assert.strictEqual(details.errorCode, ErrorCode.FLAG_NOT_FOUND)
    })
  })

  for (const consent of [false, true]) {
    it(`preserves evaluation metadata across a ${consent} to ${!consent} configuration swap`, async () => {
      provider.setConfiguration(configuration(consent))
      const details = await provider.resolveBooleanEvaluation('flag', false, { targetingKey: 'user' }, log)
      clock.tick(100)
      provider.setConfiguration(configuration(!consent))
      const next = await provider.resolveBooleanEvaluation('flag', false, { targetingKey: 'user' }, log)
      assert.strictEqual(details.value, true)
      assert.strictEqual(next.value, true)
      assert.strictEqual(details.flagMetadata.__dd_observe_full_evaluation_data, consent)
      assert.strictEqual(next.flagMetadata.__dd_observe_full_evaluation_data, !consent)
      assert.strictEqual(details.flagMetadata.__dd_eval_timestamp_ms, 1_790_150_400_000)
      assert.strictEqual(next.flagMetadata.__dd_eval_timestamp_ms, 1_790_150_400_100)
    })
  }

  for (const consent of ['true', 1]) {
    it(`does not grant consent for ${JSON.stringify(consent)}`, async () => {
      // Decoded configuration payloads can contain values outside the declared boolean type.
      provider.setConfiguration({ ...configuration(), observeFullEvaluationData: consent })
      const details = await provider.resolveBooleanEvaluation('flag', false, { targetingKey: 'user' }, log)
      assert.strictEqual(details.value, true)
      assert.strictEqual(details.variant, 'on')
      assert.strictEqual(details.errorCode, undefined)
      assert.strictEqual(details.flagMetadata.__dd_observe_full_evaluation_data, false)
    })
  }

  // Guard the bundled provider's stricter targeting rules without duplicating its full evaluator suite.
  for (const { name, operator, value, attr, variant, expected } of [
    {
      name: 'matches a string attribute',
      operator: 'ONE_OF',
      value: ['admin'],
      attr: 'admin',
      variant: 'on',
      expected: true,
    },
    {
      name: 'does not match an array attribute under a negated operator',
      operator: 'NOT_ONE_OF',
      value: ['admin'],
      attr: ['user'],
      variant: 'off',
      expected: false,
    },
    {
      name: 'does not compare a boolean attribute as a number',
      operator: 'GT',
      value: 0,
      attr: true,
      variant: 'off',
      expected: false,
    },
  ]) {
    it(`${name} through the bundled provider`, async () => {
      provider.setConfiguration(ruleConfiguration(operator, value))
      const details = await provider.resolveBooleanEvaluation('flag', false, { targetingKey: 'user', attr }, log)
      assert.strictEqual(details.variant, variant)
      assert.strictEqual(details.value, expected)
      assert.strictEqual(details.errorCode, undefined)
    })
  }
})
