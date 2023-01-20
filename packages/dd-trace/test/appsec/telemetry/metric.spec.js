'use strict'

const { expect } = require('chai')

const { Metric, Scope } = require('../../../src/appsec/telemetry/metric')

describe('Metrics', () => {
  it('should has REQUEST Scope and default values', () => {
    const metric = new Metric('test.metric', Scope.REQUEST)

    expect(metric.type).to.be.eq('count')
    expect(metric.common).to.be.true
    expect(metric.namespace).to.be.eq('appsec')
    expect(metric.hasRequestScope()).to.be.true
  })

  it('should return tags if subtag is provided', () => {
    const metric = new Metric('test.metric', Scope.REQUEST, 'metricTag', 'test_namespace')

    expect(metric.getTags()).to.be.undefined
    expect(metric.getTags('subtag')).to.be.deep.eq(['metricTag:subtag'])
    expect(metric.namespace).to.be.eq('test_namespace')
  })
})
