'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')
const { channel } = require('dc-polyfill')

require('../setup/core')
const { getConfigFresh } = require('../helpers/config')
const { assertObjectContains } = require('../../../../integration-tests/helpers')
const id = require('../../src/id')
const OtlpHttpLogExporter = require('../../src/opentelemetry/logs/otlp_http_log_exporter')
const OtlpHttpMetricExporter = require('../../src/opentelemetry/metrics/otlp_http_metric_exporter')
const { getProtobufTypes } = require('../../src/opentelemetry/otlp/protobuf_loader')
const { createOtlpTraceExporter } = require('../../src/opentelemetry/trace')
const { TEXT_MAP } = require('../../../../ext/formats')
const { USER_KEEP, USER_REJECT } = require('../../../../ext/priority')

describe('effective OpenTelemetry configuration', () => {
  let env
  let startupLog
  let warn
  let PrioritySampler
  let Tracer

  beforeEach(() => {
    env = process.env
    process.env = { DD_TRACE_STARTUP_LOGS: 'true' }
    sinon.useFakeTimers()
    warn = sinon.stub(console, 'warn')
    delete require.cache[require.resolve('../../src/startup-log')]
    startupLog = require('../../src/startup-log')
    PrioritySampler = proxyquire('../../src/priority_sampler', { './startup-log': startupLog })
    Tracer = proxyquire('../../src/opentracing/tracer', { '../priority_sampler': PrioritySampler })
  })

  afterEach(() => {
    process.env = env
    sinon.restore()
  })

  /** @param {import('../../src/config')} config */
  function diagnostics (config) {
    const before = JSON.stringify(config)
    startupLog.setStartupLogConfig(config)
    startupLog.setStartupLogPluginManager({ _pluginsByName: {} })
    startupLog.startupLog()
    const line = warn.getCalls().find(call => call.args[0].startsWith('DATADOG TRACER CONFIGURATION - '))
    const startup = JSON.parse(line.args[0].replace('DATADOG TRACER CONFIGURATION - ', ''))
    const flare = JSON.parse(JSON.stringify(startupLog.tracerInfo()))
    assert.equal(JSON.stringify(config), before, 'diagnostics must not mutate configuration')
    return [startup, flare]
  }

  /** @param {import('../../src/opentelemetry/trace/otlp_http_trace_exporter')} exporter */
  function exportTrace (exporter) {
    // Capture the real serialized resource at the transport boundary.
    // @ts-expect-error - sendPayload is protected in the exporter base class.
    const sendPayload = sinon.stub(exporter, 'sendPayload')
    exporter.export([{
      trace_id: id('123'),
      span_id: id('456'),
      parent_id: id('0'),
      name: 'test',
      resource: 'test',
      error: 0,
      meta: {},
      metrics: {},
      start: 1,
      duration: 1,
    }])
    const payload = JSON.parse(sendPayload.firstCall.args[0])
    sendPayload.restore()
    return payload
  }

  it('keeps native Datadog diagnostics current in flare after remote configuration updates', () => {
    const config = getConfigFresh()
    for (const info of diagnostics(config)) {
      assertObjectContains(info, {
        data_streams_enabled: false,
        DD_DATA_STREAMS_ENABLED: false,
        DD_DBM_PROPAGATION_MODE: 'disabled',
      })
    }

    for (const { enabled, mode } of [{ enabled: true, mode: 'full' }, { enabled: false, mode: 'disabled' }]) {
      config.setRemoteConfig({
        DD_DATA_STREAMS_ENABLED: String(enabled),
        DD_DBM_PROPAGATION_MODE: mode,
      })
      assert.equal(config.dsmEnabled, enabled)
      assert.equal(config.dbmPropagationMode, mode)
      const before = JSON.stringify(config)
      const flare = JSON.parse(JSON.stringify(startupLog.tracerInfo()))
      assertObjectContains(flare, {
        data_streams_enabled: enabled,
        DD_DATA_STREAMS_ENABLED: enabled,
        DD_DBM_PROPAGATION_MODE: mode,
      })
      assert.equal(JSON.stringify(config), before, 'diagnostics must not mutate configuration')
    }
  })

  it('retains startup exporter settings in flare when remote configuration changes unapplied inputs', () => {
    Object.assign(process.env, {
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://original:4318/v1/traces',
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'authorization=original-secret',
      OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '1234',
    })
    const config = getConfigFresh()
    const exporter = createOtlpTraceExporter(config)
    diagnostics(config)

    config.setRemoteConfig({
      OTEL_TRACES_EXPORTER: 'none',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://replacement:4318/v1/traces',
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'replacement=new-secret',
      OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '5678',
    })
    assert.equal(config.OTEL_TRACES_EXPORTER, 'none')
    assert.equal(config.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT, 5678)
    const flare = JSON.parse(JSON.stringify(startupLog.tracerInfo()))
    assert.equal(flare.OTEL_TRACES_EXPORTER, 'otlp')
    assert.equal(flare.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, 'http://original:4318/v1/traces')
    assert.equal(flare.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT, exporter.options.timeout)
    assert.deepEqual(flare.OTEL_EXPORTER_OTLP_TRACES_HEADERS, { authorization: '<redacted>' })
    assertObjectContains(exporter.options.headers, { authorization: 'original-secret' })
    assert.equal(exportTrace(exporter).resourceSpans.length, 1)
  })

  for (const startupLogs of [true, false]) {
    it(`captures the startup snapshot through tracer initialization with startupLogs=${startupLogs}`, () => {
      const RuntimeTracer = proxyquire('../../src/tracer', {
        './opentracing/tracer': Tracer,
        './startup-log': startupLog,
      })
      const config = getConfigFresh({ startupLogs, sampleRate: 0.25 })
      const tracer = new RuntimeTracer(config)
      startupLog.setStartupLogPluginManager({ _pluginsByName: {} })
      config.setRemoteConfig({ DD_TRACE_SAMPLE_RATE: '0' })
      tracer.configure(config)
      startupLog.startupLog()

      const info = JSON.parse(JSON.stringify(startupLog.tracerInfo()))
      assert.equal(info.OTEL_TRACES_SAMPLER, 'parentbased_traceidratio')
      assert.equal(info.OTEL_TRACES_SAMPLER_ARG, 0.25)
      assert.equal(info.sample_rate, 0)
      assert.equal(info.sampling_rules[0]._sampler._rate, 0)
      const lines = warn.getCalls().filter(call => call.args[0].startsWith('DATADOG TRACER CONFIGURATION - '))
      assert.equal(lines.length, startupLogs ? 1 : 0)
      if (startupLogs) {
        const logged = JSON.parse(lines[0].args[0].replace('DATADOG TRACER CONFIGURATION - ', ''))
        assert.equal(logged.OTEL_TRACES_SAMPLER_ARG, 0.25)
      }
    })
  }

  it('retains startup resource attributes in flare after runtime resources change', () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'custom=original'
    const config = getConfigFresh()
    const exporter = createOtlpTraceExporter(config)
    diagnostics(config)
    config.setRemoteConfig({ DD_TAGS: 'custom:updated' })
    assert.equal(config.tags.custom, 'updated')
    assert.deepEqual(startupLog.tracerInfo().OTEL_RESOURCE_ATTRIBUTES, { custom: 'original' })

    channel('datadog:identity:refresh').publish()
    const attributes = exportTrace(exporter).resourceSpans[0].resource.attributes
    const custom = attributes.find(attribute => attribute.key === 'custom')
    assert.equal(custom.value.stringValue, 'updated')
    assert.deepEqual(startupLog.tracerInfo().OTEL_RESOURCE_ATTRIBUTES, { custom: 'original' })
  })

  it('reports Electron delivery when an OTLP exporter is also requested', () => {
    process.env.OTEL_TRACES_EXPORTER = 'otlp'
    const config = getConfigFresh({ experimental: { exporter: 'electron' }, flushInterval: 0 })
    const onTrace = sinon.spy()
    const electron = channel('datadog:apm:electron:export')
    electron.subscribe(onTrace)
    try {
      const tracer = new Tracer(config)
      const span = tracer.startSpan('electron')
      span.finish()
      assert.equal(onTrace.callCount, 1)
      for (const info of diagnostics(config)) {
        assert.equal(info.OTEL_TRACES_EXPORTER, 'none')
        assert.equal(info.otlp_traces_export_enabled, false)
      }
    } finally {
      electron.unsubscribe(onTrace)
    }
  })

  it('distinguishes unused inputs from settings consumed by the metrics exporter', () => {
    process.env.OTEL_METRIC_EXPORT_TIMEOUT = '2345'
    process.env.OTEL_SDK_DISABLED = 'false'
    process.env.OTEL_LOGS_EXPORTER = 'otlp'
    process.env.OTEL_METRICS_EXPORTER = 'otlp'
    const config = getConfigFresh()
    assert.equal(config.OTEL_METRIC_EXPORT_TIMEOUT, 2345)
    for (const info of diagnostics(config)) {
      assert.equal(Object.hasOwn(info, 'OTEL_METRIC_EXPORT_TIMEOUT'), false)
      assert.equal(Object.hasOwn(info, 'OTEL_SDK_DISABLED'), false)
      assert.equal(Object.hasOwn(info, 'unsupported_configurations'), false)
      assert.equal(info.OTEL_LOGS_EXPORTER, 'none')
      assert.equal(info.OTEL_METRICS_EXPORTER, 'none')
    }
  })

  it('retains startup propagation settings in flare after live propagation changes', () => {
    const config = getConfigFresh({ tracePropagationStyle: ['datadog'] })
    const tracer = new Tracer(config)
    const span = tracer.startSpan('propagation')
    const original = {}
    tracer.inject(span, TEXT_MAP, original)
    assert.ok(original['x-datadog-trace-id'])
    diagnostics(config)

    config.setRemoteConfig({
      DD_TRACE_PROPAGATION_STYLE_INJECT: 'tracecontext',
      DD_TRACE_PROPAGATION_STYLE_EXTRACT: 'tracecontext',
    })
    const updated = {}
    tracer.inject(span, TEXT_MAP, updated)
    assert.ok(updated.traceparent)
    assert.equal(updated['x-datadog-trace-id'], undefined)
    assert.deepEqual(startupLog.tracerInfo().OTEL_PROPAGATORS, {
      inject: ['datadog'], extract: ['datadog'],
    })
  })

  for (const source of ['DD_TAGS', 'DD_TRACE_TAGS', 'programmatic tags']) {
    it(`reports resource attributes matching the trace payload with ${source} overrides`, () => {
      process.env.OTEL_RESOURCE_ATTRIBUTES = 'custom=otel-value'
      process.env.DD_TAGS = 'custom:dd-value'
      if (source !== 'DD_TAGS') process.env.DD_TRACE_TAGS = 'custom:trace-value'
      const config = getConfigFresh(source === 'programmatic tags' ? { tags: { custom: 'code-value' } } : undefined)
      const expected = source === 'DD_TAGS' ? 'dd-value' : source === 'DD_TRACE_TAGS' ? 'trace-value' : 'code-value'
      const exporter = createOtlpTraceExporter(config)
      const payload = exportTrace(exporter)
      const custom = payload.resourceSpans[0].resource.attributes.find(attribute => attribute.key === 'custom')
      assert.deepEqual(custom.value, { stringValue: expected })
      for (const info of diagnostics(config)) {
        assert.deepEqual(info.OTEL_RESOURCE_ATTRIBUTES, { custom: custom.value.stringValue })
      }
    })
  }

  for (const protocol of ['grpc', 'http/protobuf', 'http/json']) {
    for (const specific of [false, true]) {
      it(`reports the wire encoding for ${specific ? 'signal-specific' : 'generic'} ${protocol}`, () => {
        process.env.OTEL_EXPORTER_OTLP_PROTOCOL = specific ? 'http/json' : protocol
        if (specific) {
          for (const signal of ['TRACES', 'LOGS', 'METRICS']) {
            process.env[`OTEL_EXPORTER_OTLP_${signal}_PROTOCOL`] = protocol
          }
        }
        const config = getConfigFresh()
        const traceExporter = createOtlpTraceExporter(config)
        assert.equal(traceExporter.options.headers['Content-Type'], 'application/json')
        assert.equal(config.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL, traceExporter.protocol)
        const tracePayload = exportTrace(traceExporter)
        assert.equal(tracePayload.resourceSpans[0].scopeSpans[0].spans[0].name, 'test')
        const expected = protocol === 'grpc' ? 'http/protobuf' : protocol
        const { protoLogsService, protoMetricsService } = getProtobufTypes()
        const exporters = [
          ['LOGS', OtlpHttpLogExporter, protoLogsService, 'resourceLogs'],
          ['METRICS', OtlpHttpMetricExporter, protoMetricsService, 'resourceMetrics'],
        ]
        const output = diagnostics(config)
        for (const info of output) {
          assert.equal(info.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL, traceExporter.protocol)
        }
        for (const [signal, Exporter, protobuf, resourceKey] of exporters) {
          const key = `OTEL_EXPORTER_OTLP_${signal}_PROTOCOL`
          const exporter = new Exporter('http://localhost:4318', {}, 1000, config[key], {})
          const payload = signal === 'LOGS'
            ? exporter.transformer.transformLogRecords([])
            : exporter.transformer.transformMetrics([])
          const decoded = expected === 'http/json' ? JSON.parse(payload) : protobuf.decode(payload)
          assert.equal(decoded[resourceKey].length, 1)
          assert.equal(exporter.options.headers['Content-Type'],
            expected === 'http/json' ? 'application/json' : 'application/x-protobuf')
          assert.equal(config[key], expected)
          assert.equal(exporter.protocol, expected)
          assert.equal(exporter.transformer.protocol, expected)
          for (const info of output) assert.equal(info[key], expected)
        }
      })
    }
  }

  it('preserves signal overrides and effective protocols when Config is recalculated', () => {
    Object.assign(process.env, {
      OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
    })
    const config = getConfigFresh()
    for (const remote of [{ DD_TRACE_SAMPLE_RATE: '0.5' }, {}]) {
      config.setRemoteConfig(remote)
      assert.equal(config.OTEL_EXPORTER_OTLP_PROTOCOL, 'http/protobuf')
      assert.equal(config.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL, 'http/json')
      assert.equal(config.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL, 'http/json')
      assert.equal(config.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL, 'http/protobuf')
    }
  })

  describe('protocol fallback warnings', () => {
    let fallbackWarn

    beforeEach(() => {
      fallbackWarn = sinon.spy(require('../../src/log'), 'warn')
    })

    function warnings () {
      return fallbackWarn.getCalls().filter(call => call.args[0].startsWith('OTLP gRPC protocol'))
    }

    for (const [signal, enabledFlag] of [
      ['logs', 'DD_LOGS_OTEL_ENABLED'],
      ['metrics', 'DD_METRICS_OTEL_ENABLED'],
      ['metrics', 'OTEL_TRACES_SPAN_METRICS_ENABLED'],
    ]) {
      for (const specific of [false, true]) {
        it(`warns once for ${enabledFlag} with ${specific ? 'specific' : 'generic'} gRPC`, () => {
          process.env[enabledFlag] = 'true'
          process.env[specific
            ? `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_PROTOCOL`
            : 'OTEL_EXPORTER_OTLP_PROTOCOL'] = 'grpc'
          const config = getConfigFresh()
          assert.equal(warnings().length, 1)
          assert.deepEqual(warnings()[0].args.slice(1), [signal, 'http/protobuf'])

          for (const remote of [{ DD_TRACE_SAMPLE_RATE: '0.5' }, {}, { [enabledFlag]: 'false' }, {}]) {
            config.setRemoteConfig(remote)
            assert.equal(warnings().length, 1)
            assert.equal(config[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_PROTOCOL`], 'http/protobuf')
          }
        })
      }

      it(`warns when ${enabledFlag} becomes enabled after resolving an inactive gRPC setting`, () => {
        process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'grpc'
        process.env[enabledFlag] = 'false'
        const config = getConfigFresh()
        assert.equal(warnings().length, 0)
        config.setRemoteConfig({ [enabledFlag]: 'true' })
        assert.equal(warnings().length, 1)
        config.setRemoteConfig({ [enabledFlag]: 'true', DD_TRACE_SAMPLE_RATE: '0.5' })
        assert.equal(warnings().length, 1)
      })
    }

    it('warns independently for logs and metrics, sharing the metric warning with span stats', () => {
      Object.assign(process.env, {
        OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
        DD_LOGS_OTEL_ENABLED: 'true',
        DD_METRICS_OTEL_ENABLED: 'true',
        OTEL_TRACES_SPAN_METRICS_ENABLED: 'true',
      })
      const config = getConfigFresh()
      assert.equal(warnings().length, 2)
      config.setRemoteConfig({ DD_TRACE_SAMPLE_RATE: '0.5' })
      assert.equal(warnings().length, 2)
    })

    for (const protocol of ['http/json', 'http/protobuf']) {
      it(`does not consume a warning for supported ${protocol}`, () => {
        Object.assign(process.env, {
          OTEL_EXPORTER_OTLP_PROTOCOL: protocol,
          DD_LOGS_OTEL_ENABLED: 'true',
          DD_METRICS_OTEL_ENABLED: 'true',
        })
        const config = getConfigFresh()
        assert.equal(warnings().length, 0)
        config.setRemoteConfig({ OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' })
        assert.equal(warnings().length, 2)
      })
    }

    it('keeps warning history private to each Config instance', () => {
      process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = 'grpc'
      process.env.DD_LOGS_OTEL_ENABLED = 'true'
      getConfigFresh()
      assert.equal(warnings().length, 1)
      getConfigFresh()
      assert.equal(warnings().length, 2)
    })
  })

  for (const [name, variables, options, expectedName, expectedArgument, kept] of [
    ['always on', { OTEL_TRACES_SAMPLER: 'always_on', OTEL_TRACES_SAMPLER_ARG: '0.2' }, {},
      'parentbased_always_on', null, true],
    ['always off', { OTEL_TRACES_SAMPLER: 'always_off' }, {}, 'parentbased_always_off', null, false],
    ['ratio', { OTEL_TRACES_SAMPLER: 'traceidratio', OTEL_TRACES_SAMPLER_ARG: '0.5' }, {},
      'parentbased_traceidratio', 0.5, true],
    ['clamped ratio', { OTEL_TRACES_SAMPLER: 'traceidratio', OTEL_TRACES_SAMPLER_ARG: '2' }, {},
      'parentbased_always_on', null, true],
    ['DD environment rate', { OTEL_TRACES_SAMPLER: 'always_off', DD_TRACE_SAMPLE_RATE: '1' }, {},
      'parentbased_always_on', null, true],
    ['programmatic rate', { OTEL_TRACES_SAMPLER: 'always_on', DD_TRACE_SAMPLE_RATE: '1' }, { sampleRate: 0 },
      'parentbased_always_off', null, false],
    ['custom rules', {
      OTEL_TRACES_SAMPLER: 'always_on', DD_TRACE_SAMPLING_RULES: '[{"name":"root","sample_rate":0}]',
    }, {}, 'datadog_custom_rules', null, false],
    ['custom rules without a global rate', {
      DD_TRACE_SAMPLING_RULES: '[{"name":"root","sample_rate":0}]',
    }, {}, 'datadog_custom_rules', null, false],
    ['custom rules with an invalid global rate', {
      DD_TRACE_SAMPLE_RATE: 'invalid', DD_TRACE_SAMPLING_RULES: '[{"name":"root","sample_rate":0}]',
    }, {}, 'datadog_custom_rules', null, false],
    ['invalid custom rules', {
      OTEL_TRACES_SAMPLER: 'always_on', DD_TRACE_SAMPLING_RULES: '[{"sample_rate":"invalid"}]',
    }, {}, 'parentbased_always_on', null, true],
  ]) {
    it(`reports runtime sampling for ${name} and preserves inherited decisions`, () => {
      Object.assign(process.env, variables)
      const config = getConfigFresh(options)
      const tracer = new Tracer(config)
      const parent = tracer.extract(TEXT_MAP, {
        'x-datadog-trace-id': '18444899399302180863',
        'x-datadog-parent-id': '1',
      })
      const span = tracer.startSpan('root', { childOf: parent })
      tracer.inject(span, TEXT_MAP, {})
      assert.equal(span.context()._sampling.priority, kept ? USER_KEEP : USER_REJECT)

      // Every supported sampler remains parent-based, even when an input says always_off.
      for (const priority of [USER_KEEP, USER_REJECT]) {
        const inherited = tracer.extract(TEXT_MAP, {
          'x-datadog-trace-id': '123',
          'x-datadog-parent-id': '1',
          'x-datadog-sampling-priority': String(priority),
        })
        const child = tracer.startSpan('root', { childOf: inherited })
        tracer.inject(child, TEXT_MAP, {})
        assert.equal(child.context()._sampling.priority, priority)
      }
      for (const info of diagnostics(config)) {
        assert.equal(info.OTEL_TRACES_SAMPLER, expectedName)
        assert.equal(info.OTEL_TRACES_SAMPLER_ARG, expectedArgument)
      }
    })
  }

  it('retains the startup sampler in flare while existing sampling rules follow remote updates', () => {
    process.env.OTEL_TRACES_SAMPLER = 'always_off'
    const config = getConfigFresh()
    const sampler = new PrioritySampler(config.env, config.sampler)
    startupLog.setStartupLogConfig(config)
    startupLog.setStartupLogPluginManager({ _pluginsByName: {} })
    config.setRemoteConfig({ DD_TRACE_SAMPLING_RULES: '[{"sample_rate":1}]' })
    assert.equal(startupLog.tracerInfo().OTEL_TRACES_SAMPLER, 'parentbased_always_off')
    sampler.configure(config.env, config.sampler)
    assert.equal(startupLog.tracerInfo().OTEL_TRACES_SAMPLER, 'parentbased_always_off')
    assert.equal(startupLog.tracerInfo().sampling_rules.length, 2)
    config.setRemoteConfig({})
    sampler.configure(config.env, config.sampler)
    assert.equal(startupLog.tracerInfo().OTEL_TRACES_SAMPLER, 'parentbased_always_off')
  })

  for (const env of [{}, { OTEL_TRACES_SAMPLER: 'traceidratio' }]) {
    it(`does not claim a fixed sampler when the runtime uses agent rates: ${JSON.stringify(env)}`, () => {
      Object.assign(process.env, env)
      const config = getConfigFresh()
      // Construction publishes the same rules used by the runtime sampler.
      // eslint-disable-next-line no-new
      new PrioritySampler(config.env, config.sampler)
      for (const info of diagnostics(config)) {
        assert.equal(info.OTEL_TRACES_SAMPLER, null)
        assert.equal(info.OTEL_TRACES_SAMPLER_ARG, null)
      }
    })
  }
})
