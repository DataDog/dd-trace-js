'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')
const {
  getExecutedMetric,
  getInstrumentedMetric,
  TagKey,
  EXECUTED_SINK,
  EXECUTED_SOURCE,
  INSTRUMENTED_SINK,
  INSTRUMENTED_SOURCE,
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
      count: sinon.stub(globalNamespace, 'count').returns(metricMock),
    }

    const metric = proxyquire('../../../../src/appsec/iast/telemetry/iast-metric', {
      './namespaces': {
        getNamespaceFromContext: () => globalNamespace,
      },
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

    sinon.assert.calledOnceWithMatch(reqNamespace.count, metric.name)
    sinon.assert.calledOnceWithExactly(inc, 1)
  })

  it('should add by 42 the metric value', () => {
    const metric = new NoTaggedIastMetric('test.metric', 'REQUEST', 'tagKey')

    metric.inc(context, 42)

    sinon.assert.calledOnceWithMatch(reqNamespace.count, metric.name)
    sinon.assert.calledOnceWithExactly(inc, 42)
  })

  it('should increase by one the metric tag value', () => {
    const metric = new IastMetric('test.metric', 'REQUEST', 'tagKey')

    metric.inc(context, 'tagKey:tag1')

    sinon.assert.calledOnceWithExactly(reqNamespace.count, metric.name, 'tagKey:tag1')
    sinon.assert.calledOnceWithExactly(inc, 1)
  })

  it('should add by 42 the metric tag value', () => {
    const metric = new IastMetric('test.metric', 'REQUEST', 'tagKey')

    metric.inc(context, 'tagKey:tag1', 42)

    sinon.assert.calledOnceWithExactly(reqNamespace.count, metric.name, 'tagKey:tag1')
    sinon.assert.calledOnceWithExactly(inc, 42)
  })

  it('should format tags according with its tagKey', () => {
    const metric = new IastMetric('test.metric', 'REQUEST', 'tagKey')

    metric.formatTags('tag1', 'tag2').forEach(tag => metric.inc(context, tag, 42))

    sinon.assert.calledTwice(reqNamespace.count)
    assert.deepStrictEqual(reqNamespace.count.firstCall.args, [metric.name, ['tagKey:tag1']])
    assert.deepStrictEqual(reqNamespace.count.secondCall.args, [metric.name, ['tagKey:tag2']])
  })

  it('getExecutedMetric should return a metric depending on tag', () => {
    let metric = getExecutedMetric(TagKey.VULNERABILITY_TYPE)

    assert.strictEqual(metric, EXECUTED_SINK)

    metric = getExecutedMetric(TagKey.SOURCE_TYPE)
    assert.strictEqual(metric, EXECUTED_SOURCE)
  })

  it('getInstrumentedMetric should return a metric depending on tag', () => {
    let metric = getInstrumentedMetric(TagKey.VULNERABILITY_TYPE)

    assert.strictEqual(metric, INSTRUMENTED_SINK)

    metric = getInstrumentedMetric(TagKey.SOURCE_TYPE)
    assert.strictEqual(metric, INSTRUMENTED_SOURCE)
  })

  describe('NoTaggedIastMetric', () => {
    it('should define an empty array as its tags', () => {
      const noTagged = new NoTaggedIastMetric('notagged', 'scope')

      assert.strictEqual(noTagged.name, 'notagged')
      assert.strictEqual(noTagged.scope, 'scope')
      assert.deepStrictEqual(noTagged.tags, [])
    })

    it('should increment in 1 the metric', () => {
      const noTagged = new NoTaggedIastMetric('notagged', 'scope')
      noTagged.inc()

      sinon.assert.calledOnceWithExactly(inc, 1)
    })

    it('should reuse previous metric when calling add multiple times', () => {
      sinon.restore()
      const superCount = sinon.stub(Namespace.prototype, 'count').returns({ inc: () => {} })

      const noTagged = new NoTaggedIastMetric('notagged')

      noTagged.inc(undefined, 42)
      noTagged.inc(undefined, 42)

      sinon.assert.calledOnceWithMatch(superCount, 'notagged')
    })
  })
})
