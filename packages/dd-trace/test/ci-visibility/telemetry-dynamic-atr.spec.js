'use strict'

const assert = require('node:assert/strict')
const proxyquire = require('proxyquire')

const metricCalls = []
const {
  recordDynamicAtrRetries,
  TELEMETRY_DYNAMIC_ATR_RETRIES_ENABLED,
} = proxyquire('../../src/ci-visibility/telemetry', {
  '../telemetry/metrics': {
    manager: {
      namespace: () => ({
        count: (name, tags) => ({
          inc: (value) => metricCalls.push({ name, tags, value }),
        }),
      }),
    },
  },
})

describe('telemetry - dynamic ATR retries', () => {
  beforeEach(() => {
    metricCalls.length = 0
  })

  it('records one count metric with the accepted custom-buckets tag', () => {
    recordDynamicAtrRetries(true)

    assert.deepStrictEqual(metricCalls, [{
      name: TELEMETRY_DYNAMIC_ATR_RETRIES_ENABLED,
      tags: ['has_custom_buckets:true'],
      value: 1,
    }])
  })

  it('records one untagged count metric when EFD settings supply the buckets', () => {
    recordDynamicAtrRetries(false)

    assert.deepStrictEqual(metricCalls, [{
      name: TELEMETRY_DYNAMIC_ATR_RETRIES_ENABLED,
      tags: [],
      value: 1,
    }])
  })
})
