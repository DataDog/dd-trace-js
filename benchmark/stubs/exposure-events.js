'use strict'

function createSingleExposureEvent () {
  return {
    timestamp: Date.now(),
    allocation: { key: 'allocation-123' },
    flag: { key: 'test-flag' },
    variant: { key: 'variant-a' },
    subject: {
      id: 'user-123',
      type: 'user',
      attributes: { plan: 'premium' },
    },
  }
}

function createExposureEventArray (count = 10) {
  return Array(count).fill(null).map((_, i) => ({
    timestamp: Date.now(),
    allocation: { key: `allocation-${i}` },
    flag: { key: `test-flag-${i}` },
    variant: { key: 'variant-a' },
    subject: {
      id: `user-${i}`,
      type: 'user',
      attributes: { plan: 'premium' },
    },
  }))
}

// OpenFeature Finally-hook arguments for the EVP flagevaluation hot path.
// Mirrors what the @openfeature/server-sdk passes to a `finally` hook after an
// evaluation: hookContext (flagKey + evaluation context) and evaluationDetails
// (variant + reason + flagMetadata). Reason is present in OpenFeature details but
// intentionally ignored by the EVP flagevaluation writer.
function createFlagEvalEVPHookArgs () {
  const hookContext = {
    flagKey: 'test-flag',
    context: {
      targetingKey: 'user-123',
      plan: 'premium',
      country: 'US',
      betaTester: true,
      seatCount: 42,
    },
  }
  const evaluationDetails = {
    variant: 'variant-a',
    reason: 'TARGETING_MATCH',
    value: true,
    flagMetadata: { allocationKey: 'allocation-123' },
  }
  return { hookContext, evaluationDetails }
}

module.exports = {
  createSingleExposureEvent,
  createExposureEventArray,
  createFlagEvalEVPHookArgs,
}
