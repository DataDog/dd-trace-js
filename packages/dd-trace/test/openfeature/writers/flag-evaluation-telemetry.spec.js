'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')
const namespace = require('../../../src/telemetry/metrics').manager.namespace('general')

describe('flag evaluation metric reuse', () => {
  afterEach(() => {
    sinon.restore()
    namespace.reset()
  })

  it('reuses each bounded metric across resets without losing or duplicating counts', () => {
    const telemetry = proxyquire('../../../src/openfeature/writers/flag-evaluation-telemetry', {})
    const lookup = sinon.spy(namespace, 'count')
    telemetry.recordDropped('queue_overflow', 2)
    const value = () => namespace.toJSON().metrics.series.find(series =>
      series.metric === 'flagevaluation.rows.dropped' && series.tags.includes('reason:queue_overflow')).points[0][1]
    assert.strictEqual(value(), 2)
    namespace.reset()
    telemetry.recordDropped('queue_overflow', 3)
    assert.strictEqual(value(), 3)
    telemetry.recordDropped('queue_overflow', 4)
    assert.strictEqual(value(), 7)
    telemetry.recordDropped('customer-controlled-reason')
    assert.strictEqual(lookup.callCount, 1)
  })

  it('retries a failed metric lookup and contains a failed increment without poisoning later counts', () => {
    const telemetry = proxyquire('../../../src/openfeature/writers/flag-evaluation-telemetry', {})
    const lookup = sinon.stub(namespace, 'count').callThrough()
    lookup.onFirstCall().throws(new Error('lookup failed'))
    telemetry.recordDropped('queue_overflow')
    telemetry.recordDropped('queue_overflow', 2)
    const metric = lookup.returnValues[1]
    const increment = sinon.stub(metric, 'inc').callThrough()
    increment.onFirstCall().throws(new Error('increment failed'))
    telemetry.recordDropped('queue_overflow', 3)
    telemetry.recordDropped('queue_overflow', 4)
    assert.strictEqual(metric.toJSON().points[0][1], 6)
    assert.strictEqual(lookup.callCount, 2)
  })
})
