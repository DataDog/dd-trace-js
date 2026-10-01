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
