'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const lambda = require('../../../../lambda')

describe('Lambda facade', () => {
  it('keeps the cross-major public surface narrow', () => {
    assert.deepStrictEqual(Object.keys(lambda).sort(), [
      'getTraceHeaders',
      'reportInitFailure',
      'sendDistributionMetric',
      'sendDistributionMetricWithDate',
      'wrap',
    ])
  })

  it('returns no trace headers outside an active invocation', () => {
    assert.deepStrictEqual(lambda.getTraceHeaders(), {})
  })

  it('fails loudly on the entry points that land with the metrics pipeline', () => {
    assert.throws(() => lambda.sendDistributionMetric('m', 1), /not implemented yet/)
    assert.throws(() => lambda.sendDistributionMetricWithDate('m', 1, new Date()), /not implemented yet/)
    assert.throws(
      () => lambda.reportInitFailure({ error: new Error('x'), functionName: 'f', startTime: 0 }),
      /not implemented yet/
    )
  })
})
