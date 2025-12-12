'use strict'

const assert = require('node:assert/strict')

const { expect } = require('chai')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')
const {
  initRequestNamespace,
  finalizeRequestNamespace,
  DD_IAST_METRICS_NAMESPACE,
  globalNamespace,

  IastNamespace
} = require('../../../../src/appsec/iast/telemetry/namespaces')

const { Namespace } = require('../../../../src/telemetry/metrics')

const REQUEST_TAINTED = 'request.tainted'
const EXECUTED_SINK = 'executed.sink'
const TAG_PREFIX = '_dd.iast.telemetry'

function now () {
  return Date.now() / 1e3
}

describe('IAST metric namespaces', () => {
  let context, namespace, rootSpan

  beforeEach(() => {
    rootSpan = {
      addTags: sinon.spy()
    }
    context = {}
    namespace = initRequestNamespace(context)
  })

  afterEach(() => {
    globalNamespace.clear()
    sinon.restore()
  })

  it('should set a rootSpan tag with the flattened value of the metric', () => {
    namespace.metrics.set(REQUEST_TAINTED, {
      metric: REQUEST_TAINTED,
      points: [[now(), 5], [now(), 5]]
    })

    finalizeRequestNamespace(context, rootSpan)

    sinon.assert.called(rootSpan.addTags)

    const tag = rootSpan.addTags.getCalls()[0].args[0]
    assert.ok(`${TAG_PREFIX}.${REQUEST_TAINTED}` in tag)
    assert.strictEqual(tag[`${TAG_PREFIX}.${REQUEST_TAINTED}`], 10)

    assert.strictEqual(context[DD_IAST_METRICS_NAMESPACE], undefined)
  })

  it('should set as many rootSpan tags as different request scoped metrics', () => {
    namespace.count(REQUEST_TAINTED).inc(10)
    namespace.count(EXECUTED_SINK).inc(1)
    namespace.count(REQUEST_TAINTED).inc(5)

    finalizeRequestNamespace(context, rootSpan)

    sinon.assert.called(rootSpan.addTags)

    const calls = rootSpan.addTags.getCalls()
    const reqTaintedTag = calls[0].args[0]
    assert.ok(`${TAG_PREFIX}.${REQUEST_TAINTED}` in reqTaintedTag)
    assert.strictEqual(reqTaintedTag[`${TAG_PREFIX}.${REQUEST_TAINTED}`], 15)

    const execSinkTag = calls[1].args[0]
    assert.ok(`${TAG_PREFIX}.${EXECUTED_SINK}` in execSinkTag)
    assert.strictEqual(execSinkTag[`${TAG_PREFIX}.${EXECUTED_SINK}`], 1)
  })

  it('should merge all kind of metrics in global Namespace as gauges', () => {
    namespace.count(REQUEST_TAINTED, ['tag1:test']).inc(10)
    namespace.count(EXECUTED_SINK).inc(1)

    const metric = {
      inc: sinon.spy()
    }
    const count = sinon.stub(Namespace.prototype, 'count').returns(metric)

    finalizeRequestNamespace(context, rootSpan)

    expect(count).to.be.calledTwice
    assert.deepStrictEqual(count.firstCall.args, [REQUEST_TAINTED, ['tag1:test']])
    expect(metric.inc).to.be.calledTwice
    assert.strictEqual(metric.inc.firstCall.args[0], 10)

    assert.deepStrictEqual(count.secondCall.args, [EXECUTED_SINK, undefined])
    assert.strictEqual(metric.inc.secondCall.args[0], 1)
  })

  it('should cache metrics from different request namespaces', () => {
    const context2 = {}
    const namespace2 = initRequestNamespace(context2)
    namespace2.count(REQUEST_TAINTED, { tag1: 'test' }).inc(10)

    finalizeRequestNamespace(context2)

    const context3 = {}
    const namespace3 = initRequestNamespace(context3)
    namespace3.count(REQUEST_TAINTED, { tag1: 'test' }).inc(10)

    finalizeRequestNamespace(context3)

    assert.strictEqual(globalNamespace.iastMetrics.size, 1)
  })

  it('should clear metric and distribution collections and iast metrics cache', () => {
    namespace.count(REQUEST_TAINTED, ['tag1:test']).inc(10)
    namespace.distribution('test.distribution', ['tag2:test']).track(10)

    finalizeRequestNamespace(context)

    assert.strictEqual(namespace.iastMetrics.size, 0)
    assert.strictEqual(namespace.metrics.size, 0)
    assert.strictEqual(namespace.distributions.size, 0)
  })
})

describe('IastNamespace', () => {
  describe('getIastMetric', () => {
    it('should create an IastMetric map with metric name as its key', () => {
      const namespace = new IastNamespace()

      const metrics = namespace.getIastMetrics('metric.name')

      assert.notStrictEqual(metrics, undefined)
      assert.strictEqual(metrics instanceof Map, true)
    })

    it('should reuse the same map if created before', () => {
      const namespace = new IastNamespace()

      assert.strictEqual(namespace.getIastMetrics('metric.name'), namespace.getIastMetrics('metric.name'))
    })
  })

  describe('getMetric', () => {
    beforeEach(sinon.restore)

    it('should register a new count type metric and store it in the map', () => {
      const namespace = new IastNamespace()

      const metric = namespace.getMetric('metric.name', ['key:tag1'])

      assert.notStrictEqual(metric, undefined)
      assert.strictEqual(metric.metric, 'metric.name')
      assert.strictEqual(metric.namespace, 'iast')
      assert.strictEqual(metric.type, 'count')
      assert.deepStrictEqual(metric.tags, ['key:tag1'])
    })

    it('should register a new count type metric and store it in the map supporting non array tags', () => {
      const namespace = new IastNamespace()

      const metric = namespace.getMetric('metric.name', { key: 'tag1' })

      assert.notStrictEqual(metric, undefined)
      assert.strictEqual(metric.metric, 'metric.name')
      assert.strictEqual(metric.namespace, 'iast')
      assert.strictEqual(metric.type, 'count')
      assert.deepStrictEqual(metric.tags, ['key:tag1'])
    })

    it('should register a new distribution type metric and store it in the map', () => {
      const namespace = new IastNamespace()

      const metric = namespace.getMetric('metric.name', ['key:tag1'], 'distribution')

      assert.notStrictEqual(metric, undefined)
      assert.strictEqual(metric.metric, 'metric.name')
      assert.strictEqual(metric.namespace, 'iast')
      assert.strictEqual(metric.type, 'distribution')
      assert.deepStrictEqual(metric.tags, ['key:tag1'])
    })

    it('should not add the version tags to the tags array', () => {
      const namespace = new IastNamespace()

      const tags = ['key:tag1']
      const metric = namespace.getMetric('metric.name', tags)

      assert.deepStrictEqual(tags, ['key:tag1'])
      assert.deepStrictEqual(metric.tags, ['key:tag1'])
    })

    it('should not create a previously created metric', () => {
      const namespace = new IastNamespace()

      const metric = {}
      const count = sinon.stub(Namespace.prototype, 'count').returns(metric)

      const tags = ['key:tag1']
      namespace.getMetric('metric.name', tags)
      namespace.getMetric('metric.name', tags)

      expect(count).to.be.calledOnceWith('metric.name', tags)
    })

    it('should reuse a previously created metric', () => {
      const namespace = new IastNamespace()

      const metric = namespace.getMetric('metric.name', ['key:tag1'])

      metric.track(42)

      const metric2 = namespace.getMetric('metric.name', ['key:tag1'])

      assert.strictEqual(metric2, metric)
      assert.strictEqual(metric2.points[0][1], 42)
    })

    it('should not cache more than max tags for same metric', () => {
      const namespace = new IastNamespace(1)

      namespace.getMetric('metric.name', ['key:tag1'])

      namespace.getMetric('metric.name', ['key:tag2'])

      namespace.getMetric('metric.name', ['key:tag3'])

      assert.strictEqual(namespace.iastMetrics.size, 1)
      assert.strictEqual(namespace.iastMetrics.get('metric.name').size, 1)
    })
  })
})
