'use strict'

require('../setup/tap')

const { expect } = require('chai')

require('../../').init()

const { performance } = require('perf_hooks')

const api = require('@opentelemetry/api')
const { hrTime, timeInputToHrTime } = require('@opentelemetry/core')

const TracerProvider = require('../../src/opentelemetry/tracer_provider')
const Tracer = require('../../src/opentelemetry/tracer')
const Span = require('../../src/opentelemetry/span')

const DatadogSpan = require('../../src/opentracing/span')
const tracer = require('../../')

function isChildOf (child, parent) {
  const parentContext = parent.context()
  const childContext = child.context()

  expect(childContext.toTraceId()).to.equal(parentContext.toTraceId())
  expect(childContext.toSpanId()).to.not.equal(parentContext.toSpanId())
  expect(childContext._parentId).to.eql(parentContext._spanId)
}

describe('OTel Tracer', () => {
  it('should get resource', () => {
    const tracerProvider = new TracerProvider({
      resource: 'some resource'
    })

    const tracer = new Tracer({}, {}, tracerProvider)
    expect(tracer.resource).to.equal(tracerProvider.resource)
  })

  it('should get active span processor', () => {
    const tracerProvider = new TracerProvider()
    tracerProvider.getActiveSpanProcessor = sinon.stub()

    const tracer = new Tracer({}, {}, tracerProvider)
    const processor = tracer.getActiveSpanProcessor()
    expect(tracerProvider.getActiveSpanProcessor).to.have.been.calledOnce
    expect(processor).to.equal(tracerProvider.getActiveSpanProcessor())
  })

  it('should create a span', () => {
    const tracerProvider = new TracerProvider()
    const otelTracer = new Tracer({}, {}, tracerProvider)

    const span = otelTracer.startSpan('name')
    expect(span).to.be.an.instanceOf(Span)

    const ddSpan = span._ddSpan
    expect(ddSpan).to.be.an.instanceOf(DatadogSpan)
    expect(ddSpan._name).to.be.equal('name')
  })

  it('should create a span with attributes (tags)', () => {
    const tracerProvider = new TracerProvider()
    const otelTracer = new Tracer({}, {}, tracerProvider)

    const span = otelTracer.startSpan('name', {
      attributes: {
        foo: 'bar'
      }
    })

    const ddSpanContext = span._ddSpan.context()
    expect(ddSpanContext._tags).to.have.property('foo', 'bar')
  })

  it('should pass through span kind', () => {
    const tracerProvider = new TracerProvider()
    const otelTracer = new Tracer({}, {}, tracerProvider)

    const checks = [
      [undefined, api.SpanKind.INTERNAL], // Defaults to INTERNAL
      [api.SpanKind.INTERNAL, api.SpanKind.INTERNAL],
      [api.SpanKind.SERVER, api.SpanKind.SERVER],
      [api.SpanKind.CLIENT, api.SpanKind.CLIENT],
      [api.SpanKind.PRODUCER, api.SpanKind.PRODUCER],
      [api.SpanKind.CONSUMER, api.SpanKind.CONSUMER]
    ]

    for (const [input, output] of checks) {
      const span = otelTracer.startSpan('name', {
        kind: input
      })

      expect(span.kind).to.equal(output)
    }
  })

  it('should use given start time', () => {
    const tracerProvider = new TracerProvider()
    const otelTracer = new Tracer({}, {}, tracerProvider)

    const hrnow = process.hrtime()
    const perfnow = performance.now()
    const datenow = Date.now()

    const checks = [
      // hrtime
      [hrnow, hrnow],
      // performance.now()
      [perfnow, hrTime(perfnow)],
      // Date.now()
      [datenow, timeInputToHrTime(datenow)]
    ]

    for (const [input, output] of checks) {
      const span = otelTracer.startSpan('name', {
        startTime: input
      })
      expect(span.startTime).to.eql(output)
    }
  })

  it('should create an active span', () => {
    const tracerProvider = new TracerProvider()
    tracerProvider.register()
    const otelTracer = new Tracer({}, {}, tracerProvider)

    otelTracer.startActiveSpan('name', (span) => {
      expect(span).to.be.an.instanceOf(Span)
      expect(span._ddSpan).to.equal(tracer.scope().active())
    })
  })

  it('should auto-nest otel spans in dd spans', () => {
    const tracerProvider = new TracerProvider()
    tracerProvider.register()
    const otelTracer = new Tracer({}, {}, tracerProvider)

    tracer.trace('dd-trace-sub', (ddSpan) => {
      const otelSpan = otelTracer.startSpan('name')
      isChildOf(otelSpan._ddSpan, ddSpan)
    })
  })

  it('should auto-nest dd spans in otel spans', () => {
    const tracerProvider = new TracerProvider()
    tracerProvider.register()
    const otelTracer = new Tracer({}, {}, tracerProvider)

    otelTracer.startActiveSpan('name', (otelSpan) => {
      // NOTE: tracer.startSpan(...) does not use active context. Is this a bug?
      tracer.trace('dd-trace-sub', (ddSpan) => {
        isChildOf(ddSpan, otelSpan._ddSpan)
      })
    })
  })

  it('should auto-nest otel spans within other otel spans', () => {
    const tracerProvider = new TracerProvider()
    tracerProvider.register()
    const otelTracer = new Tracer({}, {}, tracerProvider)

    otelTracer.startActiveSpan('name', (outer) => {
      const inner = otelTracer.startSpan('name')
      isChildOf(inner._ddSpan, outer._ddSpan)
    })
  })

  it('should make manual root span', () => {
    const tracerProvider = new TracerProvider()
    tracerProvider.register()
    const otelTracer = new Tracer({}, {}, tracerProvider)

    otelTracer.startActiveSpan('name', (outer) => {
      const inner = otelTracer.startSpan('name', {
        root: true
      })

      const parentContext = outer._ddSpan.context()
      const childContext = inner._ddSpan.context()

      expect(childContext.toTraceId()).to.not.equal(parentContext.toTraceId())
      expect(childContext._parentId).to.not.eql(parentContext._spanId)
    })
  })
})
