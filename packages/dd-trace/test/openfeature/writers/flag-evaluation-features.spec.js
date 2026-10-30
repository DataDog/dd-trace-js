'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../../setup/core')

const { FlagEvaluationAggregator } = require('../../../src/openfeature/writers/flag-evaluation-aggregation')
const { iterateFlagEvaluationPayloads } = require('../../../src/openfeature/writers/flag-evaluation-payload')

function event (features, targetingKey = 'subject') {
  return {
    flagKey: 'holdout-flag',
    variant: 'control',
    allocationKey: 'holdout-allocation',
    runtimeDefault: false,
    targetingKey,
    observeFullEvaluationData: false,
    features,
    timestamp: 1_000,
  }
}

function rows (events) {
  const aggregator = new FlagEvaluationAggregator()
  for (const item of events) aggregator.add(item)
  const { full, degraded } = aggregator.take()
  const payload = Array.from(iterateFlagEvaluationPayloads(full, degraded, { service: 'test' }, 2_000))[0]
  return JSON.parse(payload.encoded).flagEvaluations
}

describe('flag evaluation count features', () => {
  it('splits buckets on the features and writes them on every row', () => {
    const result = rows([
      event({ 'holdout.key': '06ad' }),
      event({ 'holdout.key': '06ad' }),
      event({ 'holdout.key': 'other' }),
    ])

    assert.strictEqual(result.length, 2)
    const byFeature = new Map(result.map(row => [row.features['holdout.key'], row]))
    assert.strictEqual(byFeature.get('06ad').evaluation_count, 2)
    assert.strictEqual(byFeature.get('other').evaluation_count, 1)
    assert.deepStrictEqual(byFeature.get('06ad').features, { 'holdout.key': '06ad' })
  })

  it('merges buckets regardless of feature key order', () => {
    const result = rows([
      event({ 'holdout.key': '06ad', 'holdout.group': 'status_quo' }),
      event({ 'holdout.group': 'status_quo', 'holdout.key': '06ad' }),
    ])

    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0].evaluation_count, 2)
  })

  it('keeps features on rows without consent, where the targeting key is hashed', () => {
    const result = rows([event({ 'holdout.key': '06ad' })])

    assert.deepStrictEqual(result[0].features, { 'holdout.key': '06ad' })
    assert.match(result[0].targeting_key, /^sha256_/)
  })

  it('adds no features field when the split has none', () => {
    const encoded = JSON.stringify(rows([event()])[0])

    assert.ok(!encoded.includes('features'), `Encoded row: ${encoded}`)
  })
})
