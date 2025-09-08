'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

const { EXECUTED_SINK, EXECUTED_SOURCE, REQUEST_TAINTED } = require('../../../../src/appsec/iast/telemetry/iast-metric')
const { addMetricsToSpan } = require('../../../../src/appsec/iast/telemetry/span-tags')
const {
  getNamespaceFromContext,
  initRequestNamespace
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
  })

  afterEach(sinon.restore)

  it('should add span tags with tag name like \'tagPrefix.metricName.tagKey\' for tagged metrics', () => {
    EXECUTED_SOURCE.inc(context, ['source.type.1'], 42)
    EXECUTED_SINK.inc(context, ['sink_type_1'], 3)

    const { metrics } = getNamespaceFromContext(context).toJSON()

    addMetricsToSpan(rootSpan, metrics.series, tagPrefix)

    expect(rootSpan.addTags).to.be.calledTwice
    expect(rootSpan.addTags.firstCall.args[0]).to.deep.eq({ '_dd.test.executed.source.source_type_1': 42 })
    expect(rootSpan.addTags.secondCall.args[0]).to.deep.eq({ '_dd.test.executed.sink.sink_type_1': 3 })
  })

  it('should add span tags with tag name like \'tagPrefix.metricName.tagKey\' for tagged metrics flattened', () => {
    // a request metric with no context it behaves like a global metric
    EXECUTED_SOURCE.inc(context, ['source.type.1'], 42)
    EXECUTED_SOURCE.inc(context, ['source.type.1'], 32)

    const { metrics } = getNamespaceFromContext(context).toJSON()

    addMetricsToSpan(rootSpan, metrics.series, tagPrefix)

    expect(rootSpan.addTags).to.be.calledOnceWithExactly({ '_dd.test.executed.source.source_type_1': 74 })
  })

  it('should add span tags with tag name like \'tagPrefix.metricName.tagKey\' for different tagged metrics', () => {
    // a request metric with no context it behaves like a global metric
    EXECUTED_SOURCE.inc(context, ['source.type.1'], 42)
    EXECUTED_SOURCE.inc(context, ['source.type.1'], 32)

    EXECUTED_SOURCE.inc(context, ['source.type.2'], 2)

    const { metrics } = getNamespaceFromContext(context).toJSON()

    addMetricsToSpan(rootSpan, metrics.series, tagPrefix)

    expect(rootSpan.addTags).to.be.calledTwice
    expect(rootSpan.addTags.firstCall.args[0]).to.deep.eq({ '_dd.test.executed.source.source_type_1': 74 })
    expect(rootSpan.addTags.secondCall.args[0]).to.deep.eq({ '_dd.test.executed.source.source_type_2': 2 })
  })

  it('should add span tags with tag name like \'tagPrefix.metricName\' for not tagged metrics', () => {
    REQUEST_TAINTED.inc(context, 42)

    const { metrics } = getNamespaceFromContext(context).toJSON()

    addMetricsToSpan(rootSpan, metrics.series, tagPrefix)

    expect(rootSpan.addTags).to.be.calledOnceWithExactly({ '_dd.test.request.tainted': 42 })
  })
})
