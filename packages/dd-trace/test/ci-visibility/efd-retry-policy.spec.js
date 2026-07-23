'use strict'

const assert = require('node:assert/strict')

const {
  createEfdRetryPolicy,
  getEfdRetryCountForDuration,
  hasEfdRetries,
  shouldSkipEfdRetry,
} = require('../../src/ci-visibility/efd-retry-policy')

describe('EFD retry policy', () => {
  const retriesByDuration = { '5s': 10, '10s': 5, '30s': 3, '5m': 2 }
  const retryPolicy = createEfdRetryPolicy(retriesByDuration)

  it('selects the retry count at each duration boundary', () => {
    assert.strictEqual(getEfdRetryCountForDuration(0, retryPolicy), 10)
    assert.strictEqual(getEfdRetryCountForDuration(4_999, retryPolicy), 10)
    assert.strictEqual(getEfdRetryCountForDuration(5_000, retryPolicy), 5)
    assert.strictEqual(getEfdRetryCountForDuration(9_999, retryPolicy), 5)
    assert.strictEqual(getEfdRetryCountForDuration(10_000, retryPolicy), 3)
    assert.strictEqual(getEfdRetryCountForDuration(29_999, retryPolicy), 3)
    assert.strictEqual(getEfdRetryCountForDuration(30_000, retryPolicy), 2)
    assert.strictEqual(getEfdRetryCountForDuration(299_999, retryPolicy), 2)
    assert.strictEqual(getEfdRetryCountForDuration(300_000, retryPolicy), 0)
  })

  it('treats missing duration buckets as zero retries', () => {
    assert.strictEqual(getEfdRetryCountForDuration(0, createEfdRetryPolicy()), 0)
    assert.strictEqual(getEfdRetryCountForDuration(0, createEfdRetryPolicy({ '10s': 3 })), 0)
    assert.strictEqual(getEfdRetryCountForDuration(5_000, createEfdRetryPolicy({ '10s': 3 })), 3)
  })

  it('creates a scheduling policy from every configured duration bucket', () => {
    assert.deepStrictEqual(retryPolicy, {
      durationRetryCounts: [
        { durationLimitMs: 5000, retryCount: 10 },
        { durationLimitMs: 10_000, retryCount: 5 },
        { durationLimitMs: 30_000, retryCount: 3 },
        { durationLimitMs: 300_000, retryCount: 2 },
      ],
      schedulingRetryCount: 10,
    })
    assert.strictEqual(createEfdRetryPolicy({ '5s': 0, '10s': 3 }).schedulingRetryCount, 3)
    assert.strictEqual(createEfdRetryPolicy({ '10s': 3 }).schedulingRetryCount, 3)
  })

  it('does not schedule retries for empty, all-zero, unknown, or invalid duration buckets', () => {
    assert.strictEqual(createEfdRetryPolicy({}).schedulingRetryCount, 0)
    assert.strictEqual(createEfdRetryPolicy({ '5s': 0, '10s': 0 }).schedulingRetryCount, 0)
    assert.strictEqual(createEfdRetryPolicy({ '1s': 10 }).schedulingRetryCount, 0)
    assert.strictEqual(createEfdRetryPolicy({
      '5s': -1,
      '10s': 1.5,
      '30s': '3',
      '5m': Number.MAX_VALUE,
    }).schedulingRetryCount, 0)
  })

  it('distinguishes an active retry policy from a zero retry budget', () => {
    assert.strictEqual(hasEfdRetries(createEfdRetryPolicy({ '5s': 1 })), true)
    assert.strictEqual(hasEfdRetries(createEfdRetryPolicy({ '5s': 0 })), false)
    assert.strictEqual(hasEfdRetries(undefined), false)
  })

  it('skips only retries beyond the selected count', () => {
    assert.strictEqual(shouldSkipEfdRetry(1, undefined), false)
    assert.strictEqual(shouldSkipEfdRetry(2, 2), false)
    assert.strictEqual(shouldSkipEfdRetry(3, 2), true)
    assert.strictEqual(shouldSkipEfdRetry(1, 0), true)
  })
})
