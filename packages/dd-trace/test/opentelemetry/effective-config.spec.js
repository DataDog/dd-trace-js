'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')
const { getConfigFresh } = require('../helpers/config')
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

  beforeEach(() => {
    env = process.env
    process.env = { DD_TRACE_STARTUP_LOGS: 'true' }
    sinon.useFakeTimers()
    warn = sinon.stub(console, 'warn')
    delete require.cache[require.resolve('../../src/startup-log')]
    startupLog = require('../../src/startup-log')
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
        // Capture the serialized payload at the protected transport boundary without making a network request.
        // @ts-expect-error - sendPayload is protected in the exporter base class.
        const sendPayload = sinon.stub(traceExporter, 'sendPayload')
        traceExporter.export([{
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
        const tracePayload = JSON.parse(sendPayload.firstCall.args[0])
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
      const PrioritySampler = proxyquire('../../src/priority_sampler', { './startup-log': startupLog })
      const Tracer = proxyquire('../../src/opentracing/tracer', { '../priority_sampler': PrioritySampler })
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

  it('refreshes sampling diagnostics when remote rules are applied and removed', () => {
    process.env.OTEL_TRACES_SAMPLER = 'always_off'
    const config = getConfigFresh()
    const PrioritySampler = proxyquire('../../src/priority_sampler', { './startup-log': startupLog })
    const sampler = new PrioritySampler(config.env, config.sampler)
    startupLog.setStartupLogConfig(config)
    startupLog.setStartupLogPluginManager({ _pluginsByName: {} })
    config.setRemoteConfig({ DD_TRACE_SAMPLING_RULES: '[{"sample_rate":1}]' })
    sampler.configure(config.env, config.sampler)
    assert.equal(startupLog.tracerInfo().OTEL_TRACES_SAMPLER, 'datadog_custom_rules')
    config.setRemoteConfig({})
    sampler.configure(config.env, config.sampler)
    assert.equal(startupLog.tracerInfo().OTEL_TRACES_SAMPLER, 'parentbased_always_off')
  })

  for (const env of [{}, { OTEL_TRACES_SAMPLER: 'traceidratio' }]) {
    it(`does not claim a fixed sampler when the runtime uses agent rates: ${JSON.stringify(env)}`, () => {
      Object.assign(process.env, env)
      const config = getConfigFresh()
      const PrioritySampler = proxyquire('../../src/priority_sampler', { './startup-log': startupLog })
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
