'use strict'

const proxyquire = require('proxyquire')
const {
  getExecutedMetric,
  getInstrumentedMetric,
  TagKey,
  EXECUTED_SINK,
  EXECUTED_SOURCE,
  INSTRUMENTED_SINK,
  INSTRUMENTED_SOURCE
} = require('../../../../src/appsec/iast/telemetry/iast-metric')

describe('Metrics', () => {
  let IastMetric, reqNamespace, inc, context
  beforeEach(() => {
    context = {}
    inc = sinon.stub()
    const metricMock = { inc }

    const metrics = new Map()
    reqNamespace = {
      count: sinon.stub().returns(metricMock),
      getIastMetrics: () => metrics
    }

    const metric = proxyquire('../../../../src/appsec/iast/telemetry/iast-metric', {
      './namespaces': {
        getNamespaceFromContext: () => reqNamespace
      }
    })
    IastMetric = metric.IastMetric
  })

  afterEach(sinon.restore)

  it('should increase by one the metric value', () => {
    const metric = new IastMetric('test.metric', 'REQUEST')

    metric.inc(context)

    expect(reqNamespace.count).to.be.calledOnceWith(metric.name)
    expect(inc).to.be.calledOnceWith(1)
  })

  it('should add by 42 the metric value', () => {
    const metric = new IastMetric('test.metric', 'REQUEST', 'tagKey')

    metric.add(context, 42)

    expect(reqNamespace.count).to.be.calledOnceWith(metric.name)
    expect(inc).to.be.calledOnceWith(42)
  })

  it('should increase by one the metric tag value', () => {
    const metric = new IastMetric('test.metric', 'REQUEST', 'tagKey')

    metric.inc(context, metric.formatTags('tag1'))

    expect(reqNamespace.count).to.be.calledOnceWith(metric.name, ['tagKey:tag1'])
    expect(inc).to.be.calledOnceWith(1)
  })

  it('should add by 42 the metric tag value', () => {
    const metric = new IastMetric('test.metric', 'REQUEST', 'tagKey')

    metric.add(context, 42, metric.formatTags('tag1'))

    expect(reqNamespace.count).to.be.calledOnceWith(metric.name, ['tagKey:tag1'])
    expect(inc).to.be.calledOnceWith(42)
  })

  it('should add by 42 the each metric tag value', () => {
    const metric = new IastMetric('test.metric', 'REQUEST', 'tagKey')

    metric.add(context, 42, metric.formatTags('tag1', 'tag2'))

    expect(reqNamespace.count).to.be.calledTwice
    expect(reqNamespace.count.firstCall.args).to.be.deep.equals([metric.name, ['tagKey:tag1']])
    expect(reqNamespace.count.secondCall.args).to.be.deep.equals([metric.name, ['tagKey:tag2']])
  })

  it('getExecutedMetric should return a metric depending on tag', () => {
    let metric = getExecutedMetric(TagKey.VULNERABILITY_TYPE)

    expect(metric).to.be.equal(EXECUTED_SINK)

    metric = getExecutedMetric(TagKey.SOURCE_TYPE)
    expect(metric).to.be.equal(EXECUTED_SOURCE)
  })

  it('getInstrumentedMetric should return a metric depending on tag', () => {
    let metric = getInstrumentedMetric(TagKey.VULNERABILITY_TYPE)

    expect(metric).to.be.equal(INSTRUMENTED_SINK)

    metric = getInstrumentedMetric(TagKey.SOURCE_TYPE)
    expect(metric).to.be.equal(INSTRUMENTED_SOURCE)
  })
})
