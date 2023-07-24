'use strict'

const { expect } = require('chai')
const { EXECUTED_SINK, EXECUTED_SOURCE, REQUEST_TAINTED } = require('../../../../src/appsec/iast/telemetry/iast-metric')
const { addMetricsToSpan } = require('../../../../src/appsec/iast/telemetry/span-tags')
const {
  getNamespaceFromContext,
  initRequestNamespace,
  globalNamespace
} = require('../../../../src/appsec/iast/telemetry/namespaces')

describe('Telemetry Span tags', () => {
  const tagPrefix = '_dd.test'
  let rootSpan, context

  beforeEach(() => {
    rootSpan = {
      addTags: sinon.spy()
    }
    context = {}
    initRequestNamespace(context)

    globalNamespace.metrics.clear()
  })

  afterEach(sinon.restore)

  it('should add span tags with tag name like \'tagPrefix.metricName.tagKey\' for tagged metrics', () => {
    EXECUTED_SOURCE.add(42, 'source.type.1', context)
    EXECUTED_SINK.add(3, 'sink_type_1', context)

    const { metrics } = getNamespaceFromContext(context).toJSON()

    addMetricsToSpan(rootSpan, metrics.series, tagPrefix)

    expect(rootSpan.addTags).to.be.calledTwice
    expect(rootSpan.addTags.firstCall.args[0]).to.deep.eq({ '_dd.test.executed.source.source_type_1': 42 })
    expect(rootSpan.addTags.secondCall.args[0]).to.deep.eq({ '_dd.test.executed.sink.sink_type_1': 3 })
  })

  it('should add span tags with tag name like \'tagPrefix.metricName.tagKey\' for tagged metrics flattened', () => {
    // a request metric with no context it behaves like a global metric
    EXECUTED_SOURCE.add(42, 'source.type.1')
    EXECUTED_SOURCE.add(32, 'source.type.1')

    const { metrics } = globalNamespace.toJSON()

    addMetricsToSpan(rootSpan, metrics.series, tagPrefix)

    expect(rootSpan.addTags).to.be.calledOnceWithExactly({ '_dd.test.executed.source.source_type_1': 74 })
  })

  it('should add span tags with tag name like \'tagPrefix.metricName.tagKey\' for different tagged metrics', () => {
    // a request metric with no context it behaves like a global metric
    EXECUTED_SOURCE.add(42, 'source.type.1')
    EXECUTED_SOURCE.add(32, 'source.type.1')

    EXECUTED_SOURCE.add(2, 'source.type.2')

    const { metrics } = globalNamespace.toJSON()

    addMetricsToSpan(rootSpan, metrics.series, tagPrefix)

    expect(rootSpan.addTags).to.be.calledTwice
    expect(rootSpan.addTags.firstCall.args[0]).to.deep.eq({ '_dd.test.executed.source.source_type_1': 74 })
    expect(rootSpan.addTags.secondCall.args[0]).to.deep.eq({ '_dd.test.executed.source.source_type_2': 2 })
  })

  it('should add span tags with tag name like \'tagPrefix.metricName\' for not tagged metrics', () => {
    REQUEST_TAINTED.add(42, null, context)

    const { metrics } = getNamespaceFromContext(context).toJSON()

    addMetricsToSpan(rootSpan, metrics.series, tagPrefix)

    expect(rootSpan.addTags).to.be.calledOnceWithExactly({ '_dd.test.request.tainted': 42 })
  })
})
