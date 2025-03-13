'use strict'

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

    expect(rootSpan.addTags).to.be.called

    const tag = rootSpan.addTags.getCalls()[0].args[0]
    expect(tag).to.has.property(`${TAG_PREFIX}.${REQUEST_TAINTED}`)
    expect(tag[`${TAG_PREFIX}.${REQUEST_TAINTED}`]).to.be.equal(10)

    expect(context[DD_IAST_METRICS_NAMESPACE]).to.be.undefined
  })

  it('should set as many rootSpan tags as different request scoped metrics', () => {
    namespace.count(REQUEST_TAINTED).inc(10)
    namespace.count(EXECUTED_SINK).inc(1)
    namespace.count(REQUEST_TAINTED).inc(5)

    finalizeRequestNamespace(context, rootSpan)

    expect(rootSpan.addTags).to.be.called

    const calls = rootSpan.addTags.getCalls()
    const reqTaintedTag = calls[0].args[0]
    expect(reqTaintedTag).to.has.property(`${TAG_PREFIX}.${REQUEST_TAINTED}`)
    expect(reqTaintedTag[`${TAG_PREFIX}.${REQUEST_TAINTED}`]).to.be.equal(15)

    const execSinkTag = calls[1].args[0]
    expect(execSinkTag).to.has.property(`${TAG_PREFIX}.${EXECUTED_SINK}`)
    expect(execSinkTag[`${TAG_PREFIX}.${EXECUTED_SINK}`]).to.be.equal(1)
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
    expect(count.firstCall.args).to.be.deep.equal([REQUEST_TAINTED, ['tag1:test']])
    expect(metric.inc).to.be.calledTwice
    expect(metric.inc.firstCall.args[0]).to.equal(10)

    expect(count.secondCall.args).to.be.deep.equal([EXECUTED_SINK, undefined])
    expect(metric.inc.secondCall.args[0]).to.equal(1)
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

    expect(globalNamespace.iastMetrics.size).to.be.equal(1)
  })

  it('should clear metric and distribution collections and iast metrics cache', () => {
    namespace.count(REQUEST_TAINTED, ['tag1:test']).inc(10)
    namespace.distribution('test.distribution', ['tag2:test']).track(10)

    finalizeRequestNamespace(context)

    expect(namespace.iastMetrics.size).to.be.equal(0)
    expect(namespace.metrics.size).to.be.equal(0)
    expect(namespace.distributions.size).to.be.equal(0)
  })
})

describe('IastNamespace', () => {
  describe('getIastMetric', () => {
    it('should create an IastMetric map with metric name as its key', () => {
      const namespace = new IastNamespace()

      const metrics = namespace.getIastMetrics('metric.name')

      expect(metrics).to.not.undefined
      expect(metrics instanceof Map).to.be.true
    })

    it('should reuse the same map if created before', () => {
      const namespace = new IastNamespace()

      expect(namespace.getIastMetrics('metric.name')).to.be.equal(namespace.getIastMetrics('metric.name'))
    })
  })

  describe('getMetric', () => {
    beforeEach(sinon.restore)

    it('should register a new count type metric and store it in the map', () => {
      const namespace = new IastNamespace()

      const metric = namespace.getMetric('metric.name', ['key:tag1'])

      expect(metric).to.not.be.undefined
      expect(metric.metric).to.be.equal('metric.name')
      expect(metric.namespace).to.be.equal('iast')
      expect(metric.type).to.be.equal('count')
      expect(metric.tags).to.be.deep.equal(['key:tag1'])
    })

    it('should register a new count type metric and store it in the map supporting non array tags', () => {
      const namespace = new IastNamespace()

      const metric = namespace.getMetric('metric.name', { key: 'tag1' })

      expect(metric).to.not.be.undefined
      expect(metric.metric).to.be.equal('metric.name')
      expect(metric.namespace).to.be.equal('iast')
      expect(metric.type).to.be.equal('count')
      expect(metric.tags).to.be.deep.equal(['key:tag1'])
    })

    it('should register a new distribution type metric and store it in the map', () => {
      const namespace = new IastNamespace()

      const metric = namespace.getMetric('metric.name', ['key:tag1'], 'distribution')

      expect(metric).to.not.be.undefined
      expect(metric.metric).to.be.equal('metric.name')
      expect(metric.namespace).to.be.equal('iast')
      expect(metric.type).to.be.equal('distribution')
      expect(metric.tags).to.be.deep.equal(['key:tag1'])
    })

    it('should not add the version tags to the tags array', () => {
      const namespace = new IastNamespace()

      const tags = ['key:tag1']
      const metric = namespace.getMetric('metric.name', tags)

      expect(tags).to.be.deep.equal(['key:tag1'])
      expect(metric.tags).to.be.deep.equal(['key:tag1'])
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

      expect(metric2).to.be.equal(metric)
      expect(metric2.points[0][1]).to.be.equal(42)
    })

    it('should not cache more than max tags for same metric', () => {
      const namespace = new IastNamespace(1)

      namespace.getMetric('metric.name', ['key:tag1'])

      namespace.getMetric('metric.name', ['key:tag2'])

      namespace.getMetric('metric.name', ['key:tag3'])

      expect(namespace.iastMetrics.size).to.be.equal(1)
      expect(namespace.iastMetrics.get('metric.name').size).to.be.equal(1)
    })
  })
})
