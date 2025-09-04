'use strict'

const { expect } = require('chai')
const { describe, it } = require('tap').mocha
const sinon = require('sinon')
const { performance } = require('perf_hooks')
const api = require('@opentelemetry/api')
const { hrTime, timeInputToHrTime } = require('@opentelemetry/core')

require('../setup/core')

require('../../').init()

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

  it('test otel context span parenting', () => {
    const tracerProvider = new TracerProvider()
    tracerProvider.register()
    const otelTracer = new Tracer({}, {}, tracerProvider)
    otelTracer.startActiveSpan('otel-root', async (root) => {
      await new Promise(resolve => setTimeout(resolve, 200))
      otelTracer.startActiveSpan('otel-parent1', async (parent1) => {
        isChildOf(parent1._ddSpan, root._ddSpan)
        await new Promise(resolve => setTimeout(resolve, 400))
        otelTracer.startActiveSpan('otel-child1', async (child) => {
          isChildOf(child._ddSpan, parent1._ddSpan)
          await new Promise(resolve => setTimeout(resolve, 600))
        })
      })
      const orphan1 = otelTracer.startSpan('orphan1')
      isChildOf(orphan1._ddSpan, root._ddSpan)
      const ctx = api.trace.setSpan(api.context.active(), root)

      otelTracer.startActiveSpan('otel-parent2', ctx, async (parent2) => {
        isChildOf(parent2._ddSpan, root._ddSpan)
        await new Promise(resolve => setTimeout(resolve, 400))
        const ctx = api.trace.setSpan(api.context.active(), root)
        otelTracer.startActiveSpan('otel-child2', ctx, async (child) => {
          isChildOf(child._ddSpan, parent2._ddSpan)
          await new Promise(resolve => setTimeout(resolve, 600))
        })
      })
      orphan1.end()
    })
  })

  it('test otel context mixed span parenting', () => {
    const tracerProvider = new TracerProvider()
    tracerProvider.register()
    const otelTracer = new Tracer({}, {}, tracerProvider)
    otelTracer.startActiveSpan('otel-top-level', async (root) => {
      tracer.trace('ddtrace-top-level', async (ddSpan) => {
        isChildOf(ddSpan, root._ddSpan)
        await new Promise(resolve => setTimeout(resolve, 200))
        tracer.trace('ddtrace-child', async (ddSpanChild) => {
          isChildOf(ddSpanChild, ddSpan)
          await new Promise(resolve => setTimeout(resolve, 400))
        })

        otelTracer.startActiveSpan('otel-child', async (otelSpan) => {
          isChildOf(otelSpan._ddSpan, ddSpan)
          await new Promise(resolve => setTimeout(resolve, 200))
          tracer.trace('ddtrace-grandchild', async (ddSpanGrandchild) => {
            isChildOf(ddSpanGrandchild, otelSpan._ddSpan)
            otelTracer.startActiveSpan('otel-grandchild', async (otelGrandchild) => {
              isChildOf(otelGrandchild._ddSpan, ddSpanGrandchild)
              await new Promise(resolve => setTimeout(resolve, 200))
            })
          })
        })
      })
    })
  })
})
