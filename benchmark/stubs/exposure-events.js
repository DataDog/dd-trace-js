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
      attributes: { plan: 'premium' }
    }
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
      attributes: { plan: 'premium' }
    }
  }))
}

module.exports = {
  createSingleExposureEvent,
  createExposureEventArray
}
