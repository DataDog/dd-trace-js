'use strict'

const { expect } = require('chai')

const { MetricTag, getExecutedMetric, getInstrumentedMetric, EXECUTED_SINK, EXECUTED_SOURCE,
  INSTRUMENTED_SINK, INSTRUMENTED_SOURCE } =
  require('../../../src/appsec/iast/iast-metric')

describe('IastMetrics', () => {
  it('getExecutedMetric should return a metric depending on tag', () => {
    let metric = getExecutedMetric(MetricTag.VULNERABILITY_TYPE)

    expect(metric).to.be.equal(EXECUTED_SINK)

    metric = getExecutedMetric(MetricTag.SOURCE_TYPE)
    expect(metric).to.be.equal(EXECUTED_SOURCE)
  })

  it('getInstrumentedMetric should return a metric depending on tag', () => {
    let metric = getInstrumentedMetric(MetricTag.VULNERABILITY_TYPE)

    expect(metric).to.be.equal(INSTRUMENTED_SINK)

    metric = getInstrumentedMetric(MetricTag.SOURCE_TYPE)
    expect(metric).to.be.equal(INSTRUMENTED_SOURCE)
  })
})
