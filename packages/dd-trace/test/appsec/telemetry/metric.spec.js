'use strict'

const { expect } = require('chai')
const proxyquire = require('proxyquire')

const { Metric, Distribution, Scope } = require('../../../src/appsec/telemetry/metric')
const { MetricData, DistributionSeries } = require('../../../src/appsec/telemetry/handlers')

describe('Metrics', () => {
  let collector
  beforeEach(() => {
    collector = {
      addValue: sinon.spy()
    }
  })

  afterEach(sinon.restore)

  it('should has REQUEST Scope and default values', () => {
    const metric = new Metric('test.metric', Scope.REQUEST)

    expect(metric.type).to.eq('count')
    expect(metric.common).to.be.true
    expect(metric.namespace).to.eq('appsec')
    expect(metric.hasRequestScope()).to.be.true
  })

  it('should return tags if subtag is provided', () => {
    const metric = new Metric('test.metric', Scope.REQUEST, 'metricTag', 'test_namespace')

    expect(metric.getTags()).to.be.undefined
    expect(metric.getTags('subtag')).to.be.deep.eq(['metricTag:subtag'])
    expect(metric.namespace).to.eq('test_namespace')
  })

  it('should be a tagged metric if metricTag is setted', () => {
    const taggedMetric = new Metric('test.metric', Scope.REQUEST, 'metricTag', 'test_namespace')
    expect(taggedMetric.isTagged()).to.be.true

    const notTaggedMetric = new Metric('test.metric', Scope.REQUEST)
    expect(notTaggedMetric.isTagged()).to.be.false
  })

  it('should increase metric', () => {
    const telemetry = {
      isEnabled: () => true
    }

    const { Metric, Scope } = proxyquire('../../../src/appsec/telemetry/metric', {
      '.': telemetry,
      './telemetry-collector': collector
    })

    const context = {}

    const metric = new Metric('test.metric', Scope.REQUEST)
    metric.add(42, 'tag', context)

    expect(collector.addValue).to.be.calledOnceWithExactly(metric, 42, 'tag', context)
  })

  it('should increase metric', () => {
    const telemetry = {
      isEnabled: () => true,
      add: sinon.stub()
    }

    const { Metric, Scope } = proxyquire('../../../src/appsec/telemetry/metric', {
      '.': telemetry,
      './telemetry-collector': collector
    })

    const metric = new Metric('test.metric', Scope.REQUEST)
    metric.increase('tag')

    expect(collector.addValue).to.be.calledOnceWithExactly(metric, 1, 'tag', undefined)
  })

  it('should implement serialize method and return a MetricData instance', () => {
    const metric = new Metric('test.metric', Scope.REQUEST)

    const points = []
    const metricData = metric.serialize(points, 'tag')
    expect(metricData instanceof MetricData).to.be.true
    expect(metricData.points).to.be.deep.eq(points)
    expect(metricData.tag).to.eq('tag')
  })

  it('should return the point representation', () => {
    const metric = new Metric('test.metric', Scope.REQUEST)

    const point = metric.getPoint({
      timestamp: 'timestamp',
      value: 42
    })
    expect(Array.isArray(point)).to.be.true
    expect(point[0]).to.eq('timestamp')
    expect(point[1]).to.eq(42)
  })

  it('should not be a distribution', () => {
    const metric = new Metric('test.metric', Scope.REQUEST)
    expect(metric.isDistribution()).to.be.false
  })
})

describe('Distributions', () => {
  it('should implement serialize method and return a DistributionSeries instance', () => {
    const distribution = new Distribution('test.distribution', Scope.REQUEST)

    const points = []
    const series = distribution.serialize(points, 'tag')
    expect(series instanceof DistributionSeries).to.be.true
    expect(series.points).to.be.deep.eq(points)
    expect(series.tag).to.eq('tag')
  })

  it('should return the distribution point representation', () => {
    const distribution = new Distribution('test.distribution', Scope.REQUEST)

    const point = distribution.getPoint(42)
    expect(Array.isArray(point)).to.be.false
    expect(point).to.eq(42)
  })

  it('should be a distribution', () => {
    const distribution = new Distribution('test.distribution', Scope.REQUEST)
    expect(distribution.isDistribution()).to.be.true
  })
})
