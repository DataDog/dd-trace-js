'use strict'

const {
  initRequestNamespace,
  finalizeRequestNamespace,
  DD_IAST_METRICS_NAMESPACE,
  globalNamespace
} = require('../../../../src/appsec/iast/telemetry/namespaces')

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
    expect(tag).to.have.property(`${TAG_PREFIX}.${REQUEST_TAINTED}`)
    expect(tag[`${TAG_PREFIX}.${REQUEST_TAINTED}`]).to.be.eq(10)

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
    expect(reqTaintedTag).to.have.property(`${TAG_PREFIX}.${REQUEST_TAINTED}`)
    expect(reqTaintedTag[`${TAG_PREFIX}.${REQUEST_TAINTED}`]).to.be.eq(15)

    const execSinkTag = calls[1].args[0]
    expect(execSinkTag).to.have.property(`${TAG_PREFIX}.${EXECUTED_SINK}`)
    expect(execSinkTag[`${TAG_PREFIX}.${EXECUTED_SINK}`]).to.be.eq(1)
  })

  it('should merge all kind of metrics in global Namespace as gauges', () => {
    namespace.count(REQUEST_TAINTED, { tag1: 'test' }).inc(10)
    namespace.count(EXECUTED_SINK).inc(1)

    const metric = {
      inc: sinon.spy()
    }
    sinon.stub(globalNamespace, 'count').returns(metric)

    finalizeRequestNamespace(context, rootSpan)

    expect(globalNamespace.count).to.be.calledTwice
    expect(globalNamespace.count.firstCall.args).to.be.deep.equal([REQUEST_TAINTED, ['tag1:test']])
    expect(metric.inc).to.be.calledTwice
    expect(metric.inc.firstCall.args[0]).to.equal(10)

    expect(globalNamespace.count.secondCall.args).to.be.deep.equal([EXECUTED_SINK, []])
    expect(metric.inc.secondCall.args[0]).to.equal(1)
  })
})
