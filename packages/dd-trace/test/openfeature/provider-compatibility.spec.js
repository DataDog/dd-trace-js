'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')
const log = require('../../src/log')

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

describe('bundled flagging provider smoke tests', () => {
  let provider
  let clock

  beforeEach(() => {
    clock = sinon.useFakeTimers({ now: 1_790_150_400_000 })
    provider = new FlaggingProvider({}, {
      service: 'provider-compatibility',
      featureFlags: {
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
})
