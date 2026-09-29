'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')
const log = require('../../src/log')

const FlaggingProvider = proxyquire('../../src/openfeature/flagging_provider', {
  './configuration_source': { create: () => undefined },
})

/**
 * @param {string} operator
 * @param {unknown} value
 * @param {unknown} [consent]
 */
function configuration (operator = 'ONE_OF', value = ['admin'], consent) {
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
        variations: { on: { key: 'on', value: true }, off: { key: 'off', value: false } },
        allocations: [
          {
            key: 'rule',
            rules: [{ conditions: [{ attribute: 'attr', operator, value }] }],
            splits: [{ variationKey: 'on', shards: [] }],
            doLog: false,
          },
          { key: 'default', rules: [], splits: [{ variationKey: 'off', shards: [] }], doLog: false },
        ],
      },
    },
  }
}

describe('bundled flagging provider compatibility', () => {
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

  /** @type {Array<[string, unknown, unknown, boolean]>} */
  const cases = [
    ['ONE_OF', ['admin'], ['admin'], false],
    ['NOT_ONE_OF', ['admin'], ['user'], false],
    ['MATCHES', '^admin$', ['admin'], false],
    ['NOT_MATCHES', '^admin$', ['user'], false],
    ['ONE_OF', ['[object Object]'], { plan: 'pro' }, false],
    ['NOT_ONE_OF', ['admin'], { plan: 'pro' }, false],
    ['NOT_MATCHES', '^admin$', { plan: 'pro' }, false],
    ['GT', 0, true, false],
    ['GTE', 5, ' 5 ', false],
    ['GT', 10, '0x10', false],
    ['LT', 5, '', false],
    ['ONE_OF', ['true'], true, true],
    ['ONE_OF', ['5'], 5, true],
    ['GTE', 5, '5', true],
    ['ONE_OF', ['admin'], 'admin', true],
  ]
  for (const [operator, value, attr, expected] of cases) {
    it(`${operator} ${JSON.stringify(value)} with ${JSON.stringify(attr)} matches=${expected}`, async () => {
      provider.setConfiguration(configuration(operator, value))
      const details = await provider.resolveBooleanEvaluation('flag', false, { targetingKey: 'user', attr }, log)
      assert.strictEqual(details.value, expected)
      assert.strictEqual(details.variant, expected ? 'on' : 'off')
      assert.strictEqual(details.reason, expected ? 'TARGETING_MATCH' : 'STATIC')
      assert.strictEqual(details.errorCode, undefined)
    })
  }

  for (const consent of [undefined, false, true, 'true', 1]) {
    it(`exposes strict evaluation-time consent metadata for ${JSON.stringify(consent)}`, async () => {
      provider.setConfiguration(configuration('ONE_OF', ['admin'], consent))
      const details = await provider.resolveBooleanEvaluation(
        'flag', false, { targetingKey: 'user', attr: 'admin' }, log
      )
      assert.strictEqual(details.value, true)
      assert.strictEqual(details.flagMetadata.__dd_observe_full_evaluation_data, consent === true)
      assert.strictEqual(details.flagMetadata.__dd_eval_timestamp_ms, 1_790_150_400_000)
    })
  }

  for (const consent of [false, true]) {
    it(`keeps consent from the evaluated configuration across a ${consent} to ${!consent} swap`, async () => {
      const config = configuration('ONE_OF', ['admin'], consent)
      provider.setConfiguration(config)
      const details = await provider.resolveBooleanEvaluation(
        'flag', false, { targetingKey: 'user', attr: 'admin' }, log
      )
      clock.tick(100)
      provider.setConfiguration(configuration('ONE_OF', ['admin'], !consent))
      const next = await provider.resolveBooleanEvaluation('flag', false, { targetingKey: 'user', attr: 'admin' }, log)
      assert.strictEqual(details.value, true)
      assert.strictEqual(next.value, true)
      assert.strictEqual(details.flagMetadata.__dd_observe_full_evaluation_data, consent)
      assert.strictEqual(next.flagMetadata.__dd_observe_full_evaluation_data, !consent)
      assert.strictEqual(details.flagMetadata.__dd_eval_timestamp_ms, 1_790_150_400_000)
      assert.strictEqual(next.flagMetadata.__dd_eval_timestamp_ms, 1_790_150_400_100)
    })
  }
})
