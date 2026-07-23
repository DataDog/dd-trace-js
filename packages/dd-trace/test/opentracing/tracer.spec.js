'use strict'

const assert = require('node:assert/strict')
const os = require('node:os')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const opentracing = require('opentracing')
require('../setup/core')
const SpanContext = require('../../src/opentracing/span_context')
const formats = require('../../../../ext/formats')

const Reference = opentracing.Reference

describe('Tracer', () => {
  let Tracer
  let loadTracer
  let tracer
  let NativeDatadogSpan
  let span
  let spanCtx
  let PrioritySampler
  let prioritySampler
  let NativeExporter
  let SpanProcessor
  let JsSpanProcessor
  let processor
  let exporter
  let jsProcessor
  let agentExporter
  let AgentExporter
  let nativeSpansInstance
  let NativeSpansInterface
  let spanContext
  let fields
  let carrier
  let TextMapPropagator
  let HttpPropagator
  let BinaryPropagator
  let LogPropagator
  let propagator
  let config
  let log

  beforeEach(() => {
    fields = {}

    spanCtx = {
      getTag: sinon.stub().returns(undefined),
      setTag: sinon.stub(),
    }
    span = {
      addTags: sinon.stub().returns(span),
      context: sinon.stub().returns(spanCtx),
    }
    NativeDatadogSpan = sinon.stub().returns(span)

    prioritySampler = {
      sample: sinon.stub(),
    }
    PrioritySampler = sinon.stub().returns(prioritySampler)

    exporter = {
      export: sinon.spy(),
    }
    NativeExporter = sinon.stub().returns(exporter)

    processor = {
      process: sinon.spy(),
    }
    SpanProcessor = sinon.stub().returns(processor)

    jsProcessor = {
      process: sinon.spy(),
    }
    JsSpanProcessor = sinon.stub().returns(jsProcessor)

    agentExporter = {
      export: sinon.spy(),
      _url: config?.url,
    }
    AgentExporter = sinon.stub().returns(agentExporter)

    nativeSpansInstance = {}
    NativeSpansInterface = sinon.stub().returns(nativeSpansInstance)

    spanContext = {}
    carrier = {}

    TextMapPropagator = sinon.stub()
    HttpPropagator = sinon.stub()
    BinaryPropagator = sinon.stub()
    LogPropagator = sinon.stub()
    propagator = {
      inject: sinon.stub(),
      extract: sinon.stub(),
    }

    config = {
      service: 'service',
      url: 'http://test:7777',
      flushInterval: 2000,
      sampleRate: 0.5,
      logger: 'logger',
      tags: {},
      debug: true,
      experimental: {},
    }

    log = {
      use: sinon.spy(),
      toggle: sinon.spy(),
      error: sinon.spy(),
      warn: sinon.spy(),
      debug: sinon.spy(),
    }

    loadTracer = ({ isAWSLambda = false, nativeError } = {}) => proxyquire('../../src/opentracing/tracer', {
      './span_context': SpanContext,
      '../priority_sampler': PrioritySampler,
      '../span_processor': SpanProcessor,
      '../js_span_processor': JsSpanProcessor,
      './propagation/text_map': TextMapPropagator,
      './propagation/http': HttpPropagator,
      './propagation/binary': BinaryPropagator,
      './propagation/log': LogPropagator,
      '../log': log,
      '../exporters/native': NativeExporter,
      '../exporters/agent': AgentExporter,
      '../serverless': { getIsAWSLambda: () => isAWSLambda },
      '../native': {
        get NativeSpansInterface () {
          if (nativeError) throw nativeError
          return NativeSpansInterface
        },
        get NativeDatadogSpan () { return NativeDatadogSpan },
      },
    })
    Tracer = loadTracer()
  })

  it('should support recording', () => {
    tracer = new Tracer(config)

    sinon.assert.called(NativeExporter)
    sinon.assert.calledWith(NativeExporter, config, prioritySampler, nativeSpansInstance)
    sinon.assert.calledWith(SpanProcessor, exporter, prioritySampler, config, nativeSpansInstance)
  })

  it('should allow to configure an alternative prioritySampler', () => {
    const sampler = {}
    tracer = new Tracer(config, sampler)

    sinon.assert.calledWith(NativeExporter, config, sampler, nativeSpansInstance)
    sinon.assert.calledWith(SpanProcessor, exporter, sampler, config, nativeSpansInstance)
  })

  it('warns and uses native spans for unsupported APM exporters', () => {
    config.experimental.exporter = 'log'

    tracer = new Tracer(config)

    assert.strictEqual(tracer._useJsSpans, false)
    sinon.assert.calledWith(
      log.warn,
      'Native spans mode ignores unsupported experimental exporter "%s"; using native agent exporter',
      'log'
    )
    sinon.assert.calledWith(NativeExporter, config, prioritySampler, nativeSpansInstance)
  })

  it('uses the JS agent pipeline in AWS Lambda environments', () => {
    Tracer = loadTracer({ isAWSLambda: true })

    tracer = new Tracer(config)

    assert.strictEqual(tracer._useJsSpans, true)
    assert.strictEqual(tracer._isCiVisibility, false)
    sinon.assert.notCalled(NativeExporter)
    sinon.assert.notCalled(NativeSpansInterface)
    sinon.assert.calledOnceWithExactly(AgentExporter, config, prioritySampler)
    sinon.assert.calledOnceWithExactly(JsSpanProcessor, agentExporter, prioritySampler, config)
    sinon.assert.calledWith(log.debug, 'AWS Lambda environment detected (JS span pipeline)')
  })

  it('uses the JS agent pipeline when optional libdatadog is omitted', () => {
    const nativeError = Object.assign(new Error("Cannot find module '@datadog/libdatadog'"), {
      code: 'MODULE_NOT_FOUND',
    })
    Tracer = loadTracer({ nativeError })
    TextMapPropagator.returns(propagator)

    tracer = new Tracer(config)

    assert.strictEqual(tracer._useJsSpans, true)
    assert.strictEqual(tracer._isCiVisibility, false)
    sinon.assert.notCalled(NativeExporter)
    sinon.assert.calledOnceWithExactly(JsSpanProcessor, agentExporter, prioritySampler, config, undefined)
    sinon.assert.calledWith(
      log.warn,
      'Native spans unavailable because optional dependency %s is not installed; using JS span pipeline',
      '@datadog/libdatadog'
    )

    tracer.inject(spanCtx, opentracing.FORMAT_TEXT_MAP, carrier)
    sinon.assert.calledWith(propagator.inject, spanCtx, carrier)
  })

  it('does not fall back to the JS agent pipeline when native OTLP export is requested', () => {
    const nativeError = Object.assign(new Error("Cannot find module '@datadog/libdatadog'"), {
      code: 'MODULE_NOT_FOUND',
    })
    config.OTEL_TRACES_EXPORTER = 'otlp'
    Tracer = loadTracer({ nativeError })

    assert.throws(() => new Tracer(config), nativeError)
    sinon.assert.notCalled(AgentExporter)
  })

  it('does not fall back to the JS agent pipeline when installed libdatadog is corrupt', () => {
    const nativeError = Object.assign(
      new Error("Cannot find module './load'\nRequire stack:\n- node_modules/@datadog/libdatadog/index.js"),
      { code: 'MODULE_NOT_FOUND' }
    )
    Tracer = loadTracer({ nativeError })

    assert.throws(() => new Tracer(config), nativeError)
    sinon.assert.notCalled(AgentExporter)
  })

  it('treats the agent exporter as the native APM default', () => {
    config.experimental.exporter = 'agent'

    tracer = new Tracer(config)

    assert.strictEqual(tracer._useJsSpans, false)
    sinon.assert.notCalled(log.warn)
    sinon.assert.calledWith(NativeExporter, config, prioritySampler, nativeSpansInstance)
  })

  describe('startSpan', () => {
    it('should start a span', () => {
      fields.tags = { foo: 'bar' }
      fields.startTime = 1234567890000000000

      tracer = new Tracer(config)
      const testSpan = tracer.startSpan('name', fields)

      sinon.assert.calledWith(NativeDatadogSpan, tracer, processor, prioritySampler, {
        operationName: 'name',
        parent: null,
        startTime: fields.startTime,
        hostname: undefined,
        traceId128BitGenerationEnabled: undefined,
        integrationName: undefined,
        links: undefined,
      }, true, nativeSpansInstance)

      sinon.assert.calledWith(span.addTags, {
        foo: 'bar',
      })

      sinon.assert.calledWith(spanCtx.setTag, 'service.name', 'service')
      assert.strictEqual(testSpan, span)
    })

    it('should start a span that is the child of a span', () => {
      const parent = new SpanContext()

      fields.references = [
        new Reference(opentracing.REFERENCE_CHILD_OF, parent),
      ]

      tracer = new Tracer(config)
      tracer.startSpan('name', fields)

      sinon.assert.calledWithMatch(NativeDatadogSpan, tracer, processor, prioritySampler, {
        operationName: 'name',
        parent,
      })
    })

    it('should start a span that follows from a span', () => {
      const parent = new SpanContext()

      fields.references = [
        new Reference(opentracing.REFERENCE_FOLLOWS_FROM, parent),
      ]

      tracer = new Tracer(config)
      tracer.startSpan('name', fields)

      sinon.assert.calledWithMatch(NativeDatadogSpan, tracer, processor, prioritySampler, {
        operationName: 'name',
        parent,
      })
    })

    it('should start a span with the system hostname if reportHostname is enabled', () => {
      fields.tags = { foo: 'bar' }
      fields.startTime = 1234567890000000000
      config.reportHostname = true
      tracer = new Tracer(config)
      const testSpan = tracer.startSpan('name', fields)

      sinon.assert.calledWith(NativeDatadogSpan, tracer, processor, prioritySampler, {
        operationName: 'name',
        parent: null,
        startTime: fields.startTime,
        hostname: os.hostname(),
        traceId128BitGenerationEnabled: undefined,
        integrationName: undefined,
        links: undefined,
      })

      assert.strictEqual(testSpan, span)
    })

    it('should ignore additional follow references', () => {
      const parent = new SpanContext()

      fields.references = [
        new Reference(opentracing.REFERENCE_FOLLOWS_FROM, parent),
        new Reference(opentracing.REFERENCE_FOLLOWS_FROM, new SpanContext()),
      ]

      tracer = new Tracer(config)
      tracer.startSpan('name', fields)

      sinon.assert.calledWithMatch(NativeDatadogSpan, tracer, processor, prioritySampler, {
        operationName: 'name',
        parent,
      })
    })

    it('should ignore unknown references', () => {
      const parent = new SpanContext()

      fields.references = [
        new Reference('test', parent),
      ]

      tracer = new Tracer(config)
      tracer.startSpan('name', fields)

      sinon.assert.calledWithMatch(NativeDatadogSpan, tracer, processor, prioritySampler, {
        operationName: 'name',
        parent: null,
      })
    })

    it('should merge default tracer tags with span tags', () => {
      config.tags = {
        foo: 'tracer',
        bar: 'tracer',
      }

      fields.tags = {
        bar: 'span',
        baz: 'span',
      }

      tracer = new Tracer(config)
      tracer.startSpan('name', fields)

      sinon.assert.calledWith(span.addTags, config.tags)
      sinon.assert.calledWith(span.addTags, fields.tags)
    })

    it('should preserve the span version when the span service matches the global service', () => {
      fields.tags = {
        service: 'service',
        version: '1.2.3',
      }

      tracer = new Tracer(config)
      const testSpan = tracer.startSpan('name', fields)

      sinon.assert.calledWith(span.addTags, fields.tags)
      sinon.assert.calledWith(spanCtx.setTag, 'service.name', 'service')
      assert.strictEqual(fields.tags.version, '1.2.3')
      assert.strictEqual(testSpan, span)
    })

    it('If span is granted a service name that differs from the global service name' +
      'ensure spans `version` tag is undefined.', () => {
      config.tags = {
        foo: 'tracer',
        bar: 'tracer',
      }

      fields.tags = {
        bar: 'span',
        baz: 'span',
        service: 'new-service',

      }

      tracer = new Tracer(config)
      const testSpan = tracer.startSpan('name', fields)

      sinon.assert.calledWith(span.addTags, config.tags)
      sinon.assert.calledWith(span.addTags, { ...fields.tags, version: undefined })
      sinon.assert.calledWith(NativeDatadogSpan, tracer, processor, prioritySampler, {
        operationName: 'name',
        parent: null,
        startTime: fields.startTime,
        hostname: undefined,
        traceId128BitGenerationEnabled: undefined,
        integrationName: undefined,
        links: undefined,
      })
      sinon.assert.calledWith(spanCtx.setTag, 'service.name', 'new-service')
      assert.strictEqual(testSpan, span)
    })

    it('should start a span with the trace ID generation configuration', () => {
      config.traceId128BitGenerationEnabled = true
      tracer = new Tracer(config)
      const testSpan = tracer.startSpan('name', fields)

      sinon.assert.calledWith(NativeDatadogSpan, tracer, processor, prioritySampler, {
        operationName: 'name',
        parent: null,
        startTime: fields.startTime,
        hostname: undefined,
        traceId128BitGenerationEnabled: true,
        integrationName: undefined,
        links: undefined,
      })

      assert.strictEqual(testSpan, span)
    })

    it('should start a span with span links attached', () => {
      const context = new SpanContext()
      fields.links = [{ context }]
      tracer = new Tracer(config)
      const testSpan = tracer.startSpan('name', fields)

      sinon.assert.calledWith(NativeDatadogSpan, tracer, processor, prioritySampler, {
        operationName: 'name',
        parent: null,
        startTime: fields.startTime,
        hostname: undefined,
        traceId128BitGenerationEnabled: undefined,
        integrationName: undefined,
        links: [{ context }],
      })

      assert.strictEqual(testSpan, span)
    })
  })

  describe('inject', () => {
    it('should support text map format', () => {
      TextMapPropagator.returns(propagator)
      propagator.inject.returns(carrier)

      tracer = new Tracer(config)
      const injectedCarrier = tracer.inject(spanContext, opentracing.FORMAT_TEXT_MAP, carrier)

      assert.strictEqual(injectedCarrier, carrier)
      sinon.assert.calledWith(TextMapPropagator, config)
      sinon.assert.calledWith(propagator.inject, spanContext, carrier)
    })

    it('should support http headers format', () => {
      HttpPropagator.returns(propagator)

      tracer = new Tracer(config)
      tracer.inject(spanContext, opentracing.FORMAT_HTTP_HEADERS, carrier)

      sinon.assert.calledWith(HttpPropagator, config)
      sinon.assert.calledWith(propagator.inject, spanContext, carrier)
    })

    it('should support binary format', () => {
      BinaryPropagator.returns(propagator)

      tracer = new Tracer(config)
      tracer.inject(spanContext, opentracing.FORMAT_BINARY, carrier)

      sinon.assert.calledWith(propagator.inject, spanContext, carrier)
    })

    it('should handle errors', () => {
      tracer = new Tracer(config)

      const injectedCarrier = tracer.inject({})

      assert.strictEqual(injectedCarrier, undefined)
      sinon.assert.calledOnce(log.error)
    })

    it('should generate the sampling priority', () => {
      TextMapPropagator.returns(propagator)

      tracer = new Tracer(config)
      tracer.inject(spanContext, opentracing.FORMAT_TEXT_MAP, carrier)

      sinon.assert.calledWith(prioritySampler.sample, spanContext)
    })

    it('should not generate sampling priority for log injection', () => {
      LogPropagator.returns(propagator)

      tracer = new Tracer(config)
      tracer.inject(spanContext, formats.LOG, carrier)

      sinon.assert.notCalled(prioritySampler.sample)
      sinon.assert.calledWith(propagator.inject, spanContext, carrier)
    })
  })

  describe('extract', () => {
    it('should support text map format', () => {
      TextMapPropagator.returns(propagator)
      propagator.extract.withArgs(carrier).returns('spanContext')

      tracer = new Tracer(config)
      const spanContext = tracer.extract(opentracing.FORMAT_TEXT_MAP, carrier)

      assert.strictEqual(spanContext, 'spanContext')
    })

    it('should support http headers format', () => {
      HttpPropagator.returns(propagator)
      propagator.extract.withArgs(carrier).returns('spanContext')

      tracer = new Tracer(config)
      const spanContext = tracer.extract(opentracing.FORMAT_HTTP_HEADERS, carrier)

      assert.strictEqual(spanContext, 'spanContext')
    })

    it('should support binary format', () => {
      BinaryPropagator.returns(propagator)
      propagator.extract.withArgs(carrier).returns('spanContext')

      tracer = new Tracer(config)
      const spanContext = tracer.extract(opentracing.FORMAT_BINARY, carrier)

      assert.strictEqual(spanContext, 'spanContext')
    })

    it('should handle errors', () => {
      tracer = new Tracer(config)

      tracer.extract()
    })
  })
})
