'use strict'

const assert = require('node:assert/strict')

const {
  DYNAMIC_ATR_BUCKETS_ENV,
  DYNAMIC_ATR_ENABLED_ENV,
  getDynamicAtrBuckets,
  getDynamicAtrRetryCount,
  isDynamicAtrEnabled,
} = require('../../src/ci-visibility/dynamic-atr-retries')
const {
  createEfdRetryPolicy,
  EMPTY_EFD_RETRY_POLICY,
} = require('../../src/ci-visibility/efd-retry-policy')

describe('dynamic-atr-retries', () => {
  afterEach(() => {
    delete process.env[DYNAMIC_ATR_ENABLED_ENV]
    delete process.env[DYNAMIC_ATR_BUCKETS_ENV]
  })

  describe('isDynamicAtrEnabled', () => {
    for (const [value, expected] of [
      [undefined, false],
      ['', false],
      ['false', false],
      ['0', false],
      ['true', true],
      ['1', true],
    ]) {
      it(`returns ${expected} for ${value === undefined ? 'unset' : `"${value}"`}`, () => {
        if (value === undefined) {
          delete process.env[DYNAMIC_ATR_ENABLED_ENV]
        } else {
          process.env[DYNAMIC_ATR_ENABLED_ENV] = value
        }
        assert.equal(isDynamicAtrEnabled(), expected)
      })
    }
  })

  describe('getDynamicAtrBuckets', () => {
    it('returns null when unset', () => {
      delete process.env[DYNAMIC_ATR_BUCKETS_ENV]
      assert.equal(getDynamicAtrBuckets(), null)
    })

    it('returns null when empty', () => {
      process.env[DYNAMIC_ATR_BUCKETS_ENV] = ''
      assert.equal(getDynamicAtrBuckets(), null)
    })

    it('parses valid buckets', () => {
      process.env[DYNAMIC_ATR_BUCKETS_ENV] = '10,4,1,1,1'
      assert.deepEqual(getDynamicAtrBuckets(), [10, 4, 1, 1, 1])
    })

    it('returns null for wrong count', () => {
      process.env[DYNAMIC_ATR_BUCKETS_ENV] = '10,4,1'
      assert.equal(getDynamicAtrBuckets(), null)
    })

    it('returns null for value below 1', () => {
      process.env[DYNAMIC_ATR_BUCKETS_ENV] = '10,4,0,1,1'
      assert.equal(getDynamicAtrBuckets(), null)
    })

    it('returns null for value above 20', () => {
      process.env[DYNAMIC_ATR_BUCKETS_ENV] = '21,4,1,1,1'
      assert.equal(getDynamicAtrBuckets(), null)
    })

    it('returns null for non-integer', () => {
      process.env[DYNAMIC_ATR_BUCKETS_ENV] = 'invalid'
      assert.equal(getDynamicAtrBuckets(), null)
    })
  })

  describe('getDynamicAtrRetryCount', () => {
    const efdPolicy = createEfdRetryPolicy({
      '5s': 10,
      '10s': 2,
      '30s': 3,
      '5m': 4,
    })

    for (const [durationMs, expected] of [
      [1000, 10], // <= 5s -> bucket 0
      [6000, 2], // <= 10s -> bucket 1
      [31000, 4], // <= 5m -> bucket 3
      [301000, 1], // > 5m -> bucket 4, EFD returns 0, clamped to 1
      [600000, 1], // > 5m -> bucket 4, EFD returns 0, clamped to 1
    ]) {
      it(`uses EFD retry budget for ${durationMs}ms`, () => {
        assert.equal(getDynamicAtrRetryCount(durationMs, efdPolicy, null), expected)
      })
    }

    const customBuckets = [4, 1, 1, 1, 1]

    for (const [durationMs, expected] of [
      [1000, 4], // <= 5s -> bucket 0
      [6000, 1], // <= 10s -> bucket 1
      [31000, 1], // <= 30s -> bucket 2
      [301000, 1], // <= 5m -> bucket 3
      [600000, 1], // > 5m -> bucket 4
    ]) {
      it(`uses custom buckets for ${durationMs}ms`, () => {
        assert.equal(getDynamicAtrRetryCount(durationMs, efdPolicy, customBuckets), expected)
      })
    }

    it('clamps to minimum 1 when EFD returns 0', () => {
      assert.equal(getDynamicAtrRetryCount(600000, efdPolicy, null), 1)
    })

    it('clamps to minimum 1 when custom bucket is 0', () => {
      // Custom buckets with 0 in the >5m slot — getDynamicAtrRetryCount clamps to 1
      assert.equal(getDynamicAtrRetryCount(600000, efdPolicy, [5, 1, 1, 1, 0]), 1)
    })

    it('works with empty EFD policy', () => {
      assert.equal(getDynamicAtrRetryCount(1000, EMPTY_EFD_RETRY_POLICY, null), 1)
    })
  })
})

describe('efd-retry-policy dedup helpers', () => {
  const {
    retryBucketIndexForDuration,
    retriesForDuration,
  } = require('../../src/ci-visibility/efd-retry-policy')

  describe('retryBucketIndexForDuration', () => {
    for (const [durationMs, expected] of [
      [0, 0],
      [4999, 0],
      [5000, 1],
      [9999, 1],
      [10000, 2],
      [29999, 2],
      [30000, 3],
      [299999, 3],
      [300000, 4],
      [600000, 4],
    ]) {
      it(`returns ${expected} for ${durationMs}ms`, () => {
        assert.equal(retryBucketIndexForDuration(durationMs), expected)
      })
    }
  })

  describe('retriesForDuration', () => {
    const policy = createEfdRetryPolicy({
      '5s': 5,
      '10s': 3,
      '30s': 2,
      '5m': 1,
    })

    for (const [durationMs, expected] of [
      [1000, 5],
      [6000, 3],
      [31000, 1], // 31s falls in the 5m bucket (index 3)
      [301000, 0], // 301s is > 5m, no retries
      [600000, 0], // > 5m, no retries
    ]) {
      it(`returns ${expected} for ${durationMs}ms`, () => {
        assert.equal(retriesForDuration(durationMs, policy), expected)
      })
    }
  })
})
