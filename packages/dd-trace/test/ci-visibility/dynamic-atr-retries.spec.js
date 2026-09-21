'use strict'

const assert = require('node:assert/strict')

const {
  getDynamicAtrBuckets,
  getDynamicAtrRetryCount,
  isDynamicAtrEnabled,
} = require('../../src/ci-visibility/dynamic-atr-retries')
const {
  createEfdRetryPolicy,
  EMPTY_EFD_RETRY_POLICY,
} = require('../../src/ci-visibility/efd-retry-policy')

describe('dynamic-atr-retries', () => {
  describe('isDynamicAtrEnabled', () => {
    for (const [value, expected] of [
      [undefined, false],
      [false, false],
      ['true', false],
      [true, true],
    ]) {
      it(`returns ${expected} for ${String(value)}`, () => {
        assert.equal(isDynamicAtrEnabled(value), expected)
      })
    }
  })

  describe('getDynamicAtrBuckets', () => {
    it('returns null when unset', () => {
      assert.equal(getDynamicAtrBuckets(undefined), null)
    })

    it('returns null when empty', () => {
      assert.equal(getDynamicAtrBuckets(''), null)
    })

    it('parses valid buckets', () => {
      assert.deepEqual(getDynamicAtrBuckets('10,4,1,1,1'), [10, 4, 1, 1, 1])
    })

    it('returns null for wrong count', () => {
      assert.equal(getDynamicAtrBuckets('10,4,1'), null)
    })

    it('returns null for value below 1', () => {
      assert.equal(getDynamicAtrBuckets('10,4,0,1,1'), null)
    })

    it('returns null for value above 20', () => {
      assert.equal(getDynamicAtrBuckets('21,4,1,1,1'), null)
    })

    for (const value of [
      '1x,2,3,4,5',
      '1.5,2,3,4,5',
      '1,,3,4,5',
      'invalid',
    ]) {
      it(`returns null for malformed bucket value ${JSON.stringify(value)}`, () => {
        assert.equal(getDynamicAtrBuckets(value), null)
      })
    }
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
      [5000, 10], // exact 5s boundary remains in bucket 0
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
      [5000, 4], // exact 5s boundary remains in bucket 0
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
      [5000, 0],
      [9999, 1],
      [10000, 1],
      [29999, 2],
      [30000, 2],
      [299999, 3],
      [300000, 3],
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
      [5000, 5],
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
