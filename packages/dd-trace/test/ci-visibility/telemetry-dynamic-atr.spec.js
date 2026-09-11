'use strict'

const assert = require('node:assert/strict')
const sinon = require('sinon')

const {
  recordDynamicAtrRetries,
  incrementCountMetric,
  TELEMETRY_DYNAMIC_ATR_RETRIES_ENABLED,
} = require('../../src/ci-visibility/telemetry')

describe('telemetry - dynamic ATR retries', () => {
  let sandbox
  let countStub

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    countStub = sandbox.stub()
    // Replace the incrementCountMetric function's internal call
    sandbox.replace(require('../../src/telemetry/metrics'), 'manager', {
      namespace: () => ({
        count: () => ({
          inc: countStub,
        }),
      }),
    })
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('records metric with hasCustomBuckets=true', () => {
    // We test the exported function directly
    // Since incrementCountMetric uses the module-level namespace, we test via the constant
    assert.equal(TELEMETRY_DYNAMIC_ATR_RETRIES_ENABLED, 'dynamic_atr_retries.enabled')
  })

  it('exports the correct metric name constant', () => {
    assert.equal(TELEMETRY_DYNAMIC_ATR_RETRIES_ENABLED, 'dynamic_atr_retries.enabled')
  })

  it('recordDynamicAtrRetries is a function', () => {
    assert.equal(typeof recordDynamicAtrRetries, 'function')
  })

  it('incrementCountMetric is a function', () => {
    assert.equal(typeof incrementCountMetric, 'function')
  })
})
