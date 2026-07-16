'use strict'

const assert = require('node:assert/strict')

const {
  EARLY_FLAKE_DETECTION_RETRY_THRESHOLDS,
  getEfdRetryCount,
  getEfdSchedulingRetryCount,
} = require('../../src/ci-visibility/efd-retry-policy')

describe('EFD retry policy', () => {
  const slowTestRetries = { '5s': 10, '10s': 5, '30s': 3, '5m': 2 }

  it('exports the duration thresholds used by workers', () => {
    assert.deepStrictEqual(EARLY_FLAKE_DETECTION_RETRY_THRESHOLDS, [
      { limitMs: 5_000, key: '5s' },
      { limitMs: 10_000, key: '10s' },
      { limitMs: 30_000, key: '30s' },
      { limitMs: 300_000, key: '5m' },
    ])
  })

  it('selects the retry count at each duration boundary', () => {
    assert.strictEqual(getEfdRetryCount(0, slowTestRetries), 10)
    assert.strictEqual(getEfdRetryCount(4_999, slowTestRetries), 10)
    assert.strictEqual(getEfdRetryCount(5_000, slowTestRetries), 5)
    assert.strictEqual(getEfdRetryCount(9_999, slowTestRetries), 5)
    assert.strictEqual(getEfdRetryCount(10_000, slowTestRetries), 3)
    assert.strictEqual(getEfdRetryCount(29_999, slowTestRetries), 3)
    assert.strictEqual(getEfdRetryCount(30_000, slowTestRetries), 2)
    assert.strictEqual(getEfdRetryCount(299_999, slowTestRetries), 2)
    assert.strictEqual(getEfdRetryCount(300_000, slowTestRetries), 0)
  })

  it('treats missing duration buckets as zero retries', () => {
    assert.strictEqual(getEfdRetryCount(0, {}), 0)
    assert.strictEqual(getEfdRetryCount(0, { '10s': 3 }), 0)
    assert.strictEqual(getEfdRetryCount(5_000, { '10s': 3 }), 3)
  })

  it('schedules enough attempts for every configured duration bucket', () => {
    assert.strictEqual(getEfdSchedulingRetryCount(slowTestRetries), 10)
    assert.strictEqual(getEfdSchedulingRetryCount({ '5s': 0, '10s': 3 }), 3)
    assert.strictEqual(getEfdSchedulingRetryCount({ '10s': 3 }), 3)
  })

  it('does not schedule retries for empty, all-zero, or unknown duration buckets', () => {
    assert.strictEqual(getEfdSchedulingRetryCount({}), 0)
    assert.strictEqual(getEfdSchedulingRetryCount({ '5s': 0, '10s': 0 }), 0)
    assert.strictEqual(getEfdSchedulingRetryCount({ '1s': 10 }), 0)
  })
})
