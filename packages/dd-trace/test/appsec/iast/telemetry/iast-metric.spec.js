'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
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
const { globalNamespace } = require('../../../../src/appsec/iast/telemetry/namespaces')

const { Namespace } = require('../../../../src/telemetry/metrics')

describe('Metrics', () => {
  let IastMetric, NoTaggedIastMetric, reqNamespace, inc, context

  beforeEach(() => {
    context = {}
    inc = sinon.stub()
    const metricMock = { inc }

    reqNamespace = {
      count: sinon.stub(globalNamespace, 'count').returns(metricMock)
    }

    const metric = proxyquire('../../../../src/appsec/iast/telemetry/iast-metric', {
      './namespaces': {
        getNamespaceFromContext: () => globalNamespace
      }
    })
    IastMetric = metric.IastMetric
    NoTaggedIastMetric = metric.NoTaggedIastMetric
  })

  afterEach(() => {
    globalNamespace.iastMetrics.clear()
    sinon.restore()
  })

  it('should increase by one the metric value', () => {
    const metric = new NoTaggedIastMetric('test.metric', 'REQUEST')

    metric.inc(context)

    expect(reqNamespace.count).to.be.calledOnceWith(metric.name)
    expect(inc).to.be.calledOnceWith(1)
  })

  it('should add by 42 the metric value', () => {
    const metric = new NoTaggedIastMetric('test.metric', 'REQUEST', 'tagKey')

    metric.inc(context, 42)

    expect(reqNamespace.count).to.be.calledOnceWith(metric.name)
    expect(inc).to.be.calledOnceWith(42)
  })

  it('should increase by one the metric tag value', () => {
    const metric = new IastMetric('test.metric', 'REQUEST', 'tagKey')

    metric.inc(context, 'tagKey:tag1')

    expect(reqNamespace.count).to.be.calledOnceWith(metric.name, 'tagKey:tag1')
    expect(inc).to.be.calledOnceWith(1)
  })

  it('should add by 42 the metric tag value', () => {
    const metric = new IastMetric('test.metric', 'REQUEST', 'tagKey')

    metric.inc(context, 'tagKey:tag1', 42)

    expect(reqNamespace.count).to.be.calledOnceWith(metric.name, 'tagKey:tag1')
    expect(inc).to.be.calledOnceWith(42)
  })

  it('should format tags according with its tagKey', () => {
    const metric = new IastMetric('test.metric', 'REQUEST', 'tagKey')

    metric.formatTags('tag1', 'tag2').forEach(tag => metric.inc(context, tag, 42))

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

  describe('NoTaggedIastMetric', () => {
    it('should define an empty array as its tags', () => {
      const noTagged = new NoTaggedIastMetric('notagged', 'scope')

      expect(noTagged.name).to.be.eq('notagged')
      expect(noTagged.scope).to.be.eq('scope')
      expect(noTagged.tags).to.be.deep.eq([])
    })

    it('should increment in 1 the metric', () => {
      const noTagged = new NoTaggedIastMetric('notagged', 'scope')
      noTagged.inc()

      expect(inc).to.be.calledOnceWith(1)
    })

    it('should reuse previous metric when calling add multiple times', () => {
      sinon.restore()
      const superCount = sinon.stub(Namespace.prototype, 'count').returns({ inc: () => {} })

      const noTagged = new NoTaggedIastMetric('notagged')

      noTagged.inc(undefined, 42)
      noTagged.inc(undefined, 42)

      expect(superCount).to.be.calledOnceWith('notagged')
    })
  })
})
