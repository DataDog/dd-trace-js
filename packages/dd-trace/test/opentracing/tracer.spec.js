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
  let DatadogSpan
  let span
  let spanCtx
  let PrioritySampler
  let prioritySampler
  let NativeExporter
  let SpanProcessor
  let processor
  let exporter
  let agentExporter
  let AgentExporter
  let logExporter
  let LogExporter
  let agentlessExporter
  let AgentlessExporter
  let getExporter
  let otlpTraceExporter
  let createOtlpTraceExporter
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
    DatadogSpan = sinon.stub().returns(span)

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

    agentExporter = {
      export: sinon.spy(),
      _url: config?.url,
    }
    AgentExporter = sinon.stub().returns(agentExporter)

    logExporter = {
      export: sinon.spy(),
    }
    LogExporter = sinon.stub().returns(logExporter)
    agentlessExporter = {
      export: sinon.spy(),
    }
    AgentlessExporter = sinon.stub().returns(agentlessExporter)
    otlpTraceExporter = { export: sinon.spy() }
    createOtlpTraceExporter = sinon.stub().returns(otlpTraceExporter)

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

    loadTracer = ({
      agentlessSupported = true,
      encodedTracesSupported = true,
      isAWSLambda = false,
      nativeError,
      pipelineApiVersion = 1,
      jsExporter = AgentExporter,
      createOtlpSpanStatsExporter = sinon.stub(),
    } = {}) => {
      getExporter = sinon.stub().returns(jsExporter)
      getExporter.withArgs('log').returns(LogExporter)
      getExporter.withArgs('agentless').returns(AgentlessExporter)
      let WasmSpanState
      if (pipelineApiVersion < 1 || !encodedTracesSupported) {
        WasmSpanState = class WasmSpanState {}
      } else if (!agentlessSupported) {
        WasmSpanState = class WasmSpanState { sendEncodedTraces () {} }
      } else {
        WasmSpanState = class WasmSpanState {
          sendEncodedTraces () {}
          setAgentlessEndpoint () {}
        }
      }
      return proxyquire('../../src/opentracing/tracer', {
        './span_context': SpanContext,
        './span': DatadogSpan,
        '../exporter': getExporter,
        '../priority_sampler': PrioritySampler,
        '../span_processor': SpanProcessor,
        './propagation/text_map': TextMapPropagator,
        './propagation/http': HttpPropagator,
        './propagation/binary': BinaryPropagator,
        './propagation/log': LogPropagator,
        '../log': log,
        '../exporters/native': NativeExporter,
        '../opentelemetry/trace': { createOtlpTraceExporter },
        '../opentelemetry/metrics': { createOtlpSpanStatsExporter, '@noCallThru': true },
        '../serverless': { getIsAWSLambda: () => isAWSLambda },
        '../native': {
          pipelineApiVersion,
          WasmSpanState,
          get NativeSpansInterface () {
            if (nativeError) throw nativeError
            return NativeSpansInterface
          },
        },
      })
    }
    Tracer = loadTracer()
  })

  it('should support recording', () => {
    tracer = new Tracer(config)

    sinon.assert.called(NativeExporter)
    sinon.assert.calledWith(NativeExporter, config, prioritySampler, nativeSpansInstance)
    sinon.assert.calledOnceWithExactly(SpanProcessor, exporter, prioritySampler, config, undefined, false)
  })

  it('should allow to configure an alternative prioritySampler', () => {
    const sampler = {}
    tracer = new Tracer(config, sampler)

    sinon.assert.calledWith(NativeExporter, config, sampler, nativeSpansInstance)
    sinon.assert.calledOnceWithExactly(SpanProcessor, exporter, sampler, config, undefined, false)
  })

  it('uses the JS pipeline for the configured log exporter', () => {
    config.experimental.exporter = 'log'

    tracer = new Tracer(config)

    sinon.assert.notCalled(NativeExporter)
    sinon.assert.calledOnceWithExactly(LogExporter, config, prioritySampler)
    sinon.assert.calledOnceWithExactly(SpanProcessor, logExporter, prioritySampler, config, undefined)
  })

  it('uses the JS pipeline in Test Optimization mode', () => {
    config.isCiVisibility = true

    tracer = new Tracer(config)

    sinon.assert.notCalled(NativeExporter)
    sinon.assert.calledOnceWithExactly(AgentExporter, config, prioritySampler)
    sinon.assert.calledWith(log.debug, 'CI Visibility mode enabled (JS span pipeline)', undefined)
  })

  it('uses the native pipeline for the configured agentless exporter', () => {
    config.experimental.exporter = 'agentless'
    config.stats = { DD_TRACE_STATS_COMPUTATION_ENABLED: true }

    tracer = new Tracer(config)

    sinon.assert.notCalled(AgentlessExporter)
    sinon.assert.calledOnce(NativeSpansInterface)
    assert.strictEqual(NativeSpansInterface.firstCall.args[0].statsEnabled, false)
    sinon.assert.calledOnceWithExactly(NativeExporter, config, prioritySampler, nativeSpansInstance)
    sinon.assert.calledOnceWithExactly(SpanProcessor, exporter, prioritySampler, config, undefined, false)
  })

  it('warns and uses the native exporter for unsupported APM exporters', () => {
    config.experimental.exporter = 'unsupported'

    tracer = new Tracer(config)

    sinon.assert.calledWith(
      log.warn,
      'Native exporter ignores unsupported experimental exporter "%s"; using native agent exporter',
      'unsupported'
    )
    sinon.assert.calledWith(NativeExporter, config, prioritySampler, nativeSpansInstance)
  })

  it('uses the JS agent pipeline in AWS Lambda when a local agent is present', () => {
    Tracer = loadTracer({ isAWSLambda: true })

    tracer = new Tracer(config)

    assert.strictEqual(tracer._isCiVisibility, false)
    sinon.assert.notCalled(NativeExporter)
    sinon.assert.notCalled(NativeSpansInterface)
    sinon.assert.notCalled(LogExporter)
    sinon.assert.calledOnceWithExactly(AgentExporter, config, prioritySampler)
    sinon.assert.calledWithExactly(getExporter, undefined)
    sinon.assert.calledOnceWithExactly(SpanProcessor, agentExporter, prioritySampler, config, undefined)
    sinon.assert.calledWith(log.debug, 'AWS Lambda environment detected (JS span pipeline)')
  })

  it('preserves native agentless export in AWS Lambda environments', () => {
    config.experimental.exporter = 'agentless'
    Tracer = loadTracer({ isAWSLambda: true })

    tracer = new Tracer(config)

    sinon.assert.notCalled(AgentlessExporter)
    sinon.assert.calledOnce(NativeSpansInterface)
    sinon.assert.calledOnceWithExactly(NativeExporter, config, prioritySampler, nativeSpansInstance)
  })

  it('exports to stdout in AWS Lambda when neither the extension nor the mini agent is present', () => {
    // The Datadog Forwarder deployment has no local agent: traces are written to
    // stdout and shipped from CloudWatch. Sending them to 127.0.0.1:8126 instead
    // (config also forces flushInterval=0 here) loses every trace silently.
    Tracer = loadTracer({ isAWSLambda: true, jsExporter: LogExporter })

    tracer = new Tracer(config)

    sinon.assert.notCalled(NativeExporter)
    sinon.assert.notCalled(NativeSpansInterface)
    sinon.assert.notCalled(AgentExporter)
    sinon.assert.calledOnceWithExactly(LogExporter, config, prioritySampler)
    sinon.assert.calledWithExactly(getExporter, undefined)
    sinon.assert.calledOnceWithExactly(SpanProcessor, logExporter, prioritySampler, config, undefined)
  })

  it('preserves explicit OTLP export in AWS Lambda environments', () => {
    config.OTEL_TRACES_EXPORTER = 'otlp'
    config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://collector.example:4318/v1/traces'
    Tracer = loadTracer({ isAWSLambda: true })

    tracer = new Tracer(config)

    sinon.assert.notCalled(AgentExporter)
    sinon.assert.calledOnce(NativeSpansInterface)
    sinon.assert.calledWith(NativeExporter, config, prioritySampler, nativeSpansInstance)
  })

  it('uses the JS agent pipeline when optional libdatadog is omitted', () => {
    const nativeError = Object.assign(new Error("Cannot find module '@datadog/libdatadog'"), {
      code: 'MODULE_NOT_FOUND',
    })
    Tracer = loadTracer({ nativeError })
    TextMapPropagator.returns(propagator)

    tracer = new Tracer(config)

    assert.strictEqual(tracer._isCiVisibility, false)
    sinon.assert.notCalled(NativeExporter)
    sinon.assert.calledOnceWithExactly(SpanProcessor, agentExporter, prioritySampler, config, undefined)
    sinon.assert.calledWith(
      log.warn,
      'Native exporter unavailable because %s; using JS exporter pipeline',
      'optional dependency @datadog/libdatadog is not installed'
    )

    tracer.inject(spanCtx, opentracing.FORMAT_TEXT_MAP, carrier)
    sinon.assert.calledWith(propagator.inject, spanCtx, carrier)
  })

  it('uses the JS agent pipeline when libdatadog predates encoded trace export', () => {
    Tracer = loadTracer({ pipelineApiVersion: 0 })

    tracer = new Tracer(config)

    sinon.assert.notCalled(NativeExporter)
    sinon.assert.calledOnceWithExactly(AgentExporter, config, prioritySampler)
    sinon.assert.calledOnceWithExactly(SpanProcessor, agentExporter, prioritySampler, config, undefined)
    sinon.assert.calledWith(
      log.warn,
      'Native exporter unavailable because %s; using JS exporter pipeline',
      'the installed @datadog/libdatadog does not support encoded trace export',
    )
  })

  it('uses the JS agent pipeline when libdatadog lacks encoded trace export', () => {
    Tracer = loadTracer({ encodedTracesSupported: false })

    tracer = new Tracer(config)

    sinon.assert.notCalled(NativeExporter)
    sinon.assert.calledOnceWithExactly(AgentExporter, config, prioritySampler)
    sinon.assert.calledOnceWithExactly(SpanProcessor, agentExporter, prioritySampler, config, undefined)
    sinon.assert.calledWith(
      log.warn,
      'Native exporter unavailable because %s; using JS exporter pipeline',
      'the installed @datadog/libdatadog does not support encoded trace export',
    )
  })

  it('falls back to the JS OTLP exporter when libdatadog is missing', () => {
    const nativeError = Object.assign(new Error("Cannot find module '@datadog/libdatadog'"), {
      code: 'MODULE_NOT_FOUND',
    })
    config.OTEL_TRACES_EXPORTER = 'otlp'
    Tracer = loadTracer({ nativeError })

    tracer = new Tracer(config)

    sinon.assert.notCalled(NativeExporter)
    sinon.assert.notCalled(AgentExporter)
    sinon.assert.calledOnceWithExactly(createOtlpTraceExporter, config)
    sinon.assert.calledOnceWithExactly(SpanProcessor, otlpTraceExporter, prioritySampler, config, undefined)
  })

  it('preserves agentless precedence when libdatadog is missing', () => {
    const nativeError = Object.assign(new Error("Cannot find module '@datadog/libdatadog'"), {
      code: 'MODULE_NOT_FOUND',
    })
    config.experimental.exporter = 'agentless'
    config.OTEL_TRACES_EXPORTER = 'otlp'
    Tracer = loadTracer({ nativeError })

    tracer = new Tracer(config)

    sinon.assert.notCalled(NativeExporter)
    sinon.assert.notCalled(createOtlpTraceExporter)
    sinon.assert.calledOnceWithExactly(AgentlessExporter, config, prioritySampler)
    sinon.assert.calledOnceWithExactly(SpanProcessor, agentlessExporter, prioritySampler, config, undefined)
  })

  it('uses the JS agentless pipeline when libdatadog lacks agentless export', () => {
    config.experimental.exporter = 'agentless'
    Tracer = loadTracer({ agentlessSupported: false })

    tracer = new Tracer(config)

    sinon.assert.notCalled(NativeExporter)
    sinon.assert.calledOnceWithExactly(AgentlessExporter, config, prioritySampler)
    sinon.assert.calledOnceWithExactly(SpanProcessor, agentlessExporter, prioritySampler, config, undefined)
    sinon.assert.calledWith(
      log.warn,
      'Native exporter unavailable because %s; using JS exporter pipeline',
      'the installed @datadog/libdatadog does not support agentless export',
    )
  })

  it('uses the JS agent pipeline when the runtime has no WebAssembly', () => {
    // libdatadog's loader throws a bare ReferenceError with no `code`, so the
    // missing-module predicate cannot match it. Rethrowing leaves proxy.js with a
    // NoopTracer, so `node --jitless` - and any JIT-disabled or hardened
    // deployment - loses tracing entirely, silently, on a runtime where the JS
    // pipeline works fine.
    const nativeError = new ReferenceError('WebAssembly is not defined')
    Tracer = loadTracer({ nativeError })
    const wasm = globalThis.WebAssembly
    delete globalThis.WebAssembly
    try {
      tracer = new Tracer(config)
    } finally {
      globalThis.WebAssembly = wasm
    }

    sinon.assert.notCalled(NativeExporter)
    sinon.assert.calledOnceWithExactly(AgentExporter, config, prioritySampler)
    sinon.assert.calledWith(
      log.warn,
      'Native exporter unavailable because %s; using JS exporter pipeline',
      'this runtime has no WebAssembly support'
    )
  })

  it('uses the JS agent pipeline when a custom DNS lookup is configured', () => {
    // libdatadog's transport builds its own `http.request` options and takes no
    // lookup hook, so the native exporter silently drops the callback and
    // traces go wherever the system resolver points. Users who set `lookup` are
    // resolving the agent through service discovery, so honouring it matters more
    // than using the native exporter.
    config.lookup = (hostname, options, callback) => callback(null, '127.0.0.1', 4)
    config.getOrigin = sinon.stub().withArgs('lookup').returns('code')
    Tracer = loadTracer()

    tracer = new Tracer(config)

    assert.strictEqual(tracer._isCiVisibility, false)
    sinon.assert.notCalled(NativeExporter)
    sinon.assert.notCalled(NativeSpansInterface)
    sinon.assert.calledOnceWithExactly(AgentExporter, config, prioritySampler)
  })

  it('stays on the native exporter when lookup is only the default', () => {
    // `config.lookup` is always a function - it defaults to `dns.lookup` - so the
    // guard has to key off where the value came from. It cannot compare against
    // `dns.lookup` either: the dns plugin wraps that in place, so an identity
    // check would report "custom" for every default install once instrumentation
    // is active, silently dropping everyone off the native pipeline.
    config.lookup = (hostname, options, callback) => callback(null, '127.0.0.1', 4)
    config.getOrigin = sinon.stub().withArgs('lookup').returns('default')
    Tracer = loadTracer()

    tracer = new Tracer(config)

    sinon.assert.calledOnce(NativeSpansInterface)
  })

  it('keeps OTLP export when a custom DNS lookup is also configured', () => {
    // OTLP export lives in libdatadog, so the JS pipeline cannot do it at all.
    // Routing there for the sake of `lookup` would quietly ship every span to the
    // agent instead of the configured collector - a worse failure than resolving
    // the collector with the system resolver.
    config.OTEL_TRACES_EXPORTER = 'otlp'
    config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://collector.example:4318/v1/traces'
    config.lookup = (hostname, options, callback) => callback(null, '127.0.0.1', 4)
    config.getOrigin = sinon.stub().withArgs('lookup').returns('code')
    Tracer = loadTracer()

    tracer = new Tracer(config)

    sinon.assert.notCalled(AgentExporter)
    sinon.assert.calledWith(NativeExporter, config, prioritySampler, nativeSpansInstance)
    // The dropped `lookup` must be announced, not silently ignored.
    sinon.assert.calledWith(
      log.warn,
      'OTLP trace export cannot honour a custom `lookup`; resolving the collector with the system resolver'
    )
  })

  it('uses the JS OTLP exporter in Lambda when libdatadog is missing', () => {
    const nativeError = Object.assign(new Error("Cannot find module '@datadog/libdatadog'"), {
      code: 'MODULE_NOT_FOUND',
    })
    config.OTEL_TRACES_EXPORTER = 'otlp'
    Tracer = loadTracer({ nativeError, isAWSLambda: true })

    tracer = new Tracer(config)

    sinon.assert.notCalled(AgentExporter)
    sinon.assert.notCalled(LogExporter)
    sinon.assert.calledOnceWithExactly(createOtlpTraceExporter, config)
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

    sinon.assert.notCalled(log.warn)
    sinon.assert.calledWith(NativeExporter, config, prioritySampler, nativeSpansInstance)
  })

  it('constructs the default Agent URL from hostname and port', () => {
    delete config.url
    config.hostname = 'agent.internal'
    config.port = 9126

    tracer = new Tracer(config)

    assert.strictEqual(NativeSpansInterface.firstCall.args[0].agentUrl, 'http://agent.internal:9126/')
  })

  it('forwards the OTLP span stats exporter in the JS exporter pipeline', () => {
    // Every other SpanProcessor assertion in this file expects `undefined` as
    // the stats-exporter argument, because nothing else here sets
    // OTEL_TRACES_SPAN_METRICS_ENABLED — so a branch that hardcoded `undefined`
    // would pass the whole suite. Config forces
    // DD_TRACE_STATS_COMPUTATION_ENABLED when OTLP span metrics are on, so
    // dropping the exporter here ships v0.6 client stats to the agent instead of
    // OTLP metrics.
    const otlpStats = { export: sinon.spy() }
    const createOtlpSpanStatsExporter = sinon.stub().returns(otlpStats)
    config.OTEL_TRACES_SPAN_METRICS_ENABLED = true
    Tracer = loadTracer({
      isAWSLambda: true,
      createOtlpSpanStatsExporter,
    })

    tracer = new Tracer(config)

    sinon.assert.calledOnceWithExactly(createOtlpSpanStatsExporter, config)
    sinon.assert.calledOnceWithExactly(SpanProcessor, agentExporter, prioritySampler, config, otlpStats)
  })

  it('forwards the OTLP span stats exporter in the native exporter pipeline', () => {
    const otlpStats = { export: sinon.spy() }
    const createOtlpSpanStatsExporter = sinon.stub().returns(otlpStats)
    config.OTEL_TRACES_SPAN_METRICS_ENABLED = true
    Tracer = loadTracer({ createOtlpSpanStatsExporter })

    tracer = new Tracer(config)

    sinon.assert.calledOnceWithExactly(
      SpanProcessor, exporter, prioritySampler, config, otlpStats, false
    )
  })

  it('lets native stats own APM stats when OTLP span metrics are disabled', () => {
    config.stats = { DD_TRACE_STATS_COMPUTATION_ENABLED: true }

    tracer = new Tracer(config)

    sinon.assert.calledOnceWithExactly(
      SpanProcessor,
      exporter,
      prioritySampler,
      config,
      undefined,
      true
    )
  })

  describe('startSpan', () => {
    it('should start a span', () => {
      fields.tags = { foo: 'bar' }
      fields.startTime = 1234567890000000000

      tracer = new Tracer(config)
      const testSpan = tracer.startSpan('name', fields)

      sinon.assert.calledWith(DatadogSpan, tracer, processor, prioritySampler, {
        operationName: 'name',
        parent: null,
        startTime: fields.startTime,
        hostname: undefined,
        traceId128BitGenerationEnabled: undefined,
        integrationName: undefined,
        links: undefined,
      })

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

      sinon.assert.calledWithMatch(DatadogSpan, tracer, processor, prioritySampler, {
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

      sinon.assert.calledWithMatch(DatadogSpan, tracer, processor, prioritySampler, {
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

      sinon.assert.calledWith(DatadogSpan, tracer, processor, prioritySampler, {
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

      sinon.assert.calledWithMatch(DatadogSpan, tracer, processor, prioritySampler, {
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

      sinon.assert.calledWithMatch(DatadogSpan, tracer, processor, prioritySampler, {
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
      sinon.assert.calledWith(DatadogSpan, tracer, processor, prioritySampler, {
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

      sinon.assert.calledWith(DatadogSpan, tracer, processor, prioritySampler, {
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

      sinon.assert.calledWith(DatadogSpan, tracer, processor, prioritySampler, {
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
