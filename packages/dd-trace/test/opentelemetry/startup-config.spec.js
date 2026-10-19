'use strict'

const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const { once } = require('node:events')
const http = require('node:http')

const { describe, it } = require('mocha')

require('../setup/core')
const { fixture, runStartup: run } = require('../helpers/config')
const { getProtobufTypes } = require('../../src/opentelemetry/otlp/protobuf_loader')

const allSignals = {
  OTEL_TRACES_EXPORTER: 'otlp',
  DD_LOGS_OTEL_ENABLED: 'true',
  DD_METRICS_OTEL_ENABLED: 'true',
}

describe('effective OTel startup configuration', () => {
  it('reports resolved defaults without advertising inactive exporters', () => {
    const { configuration: c } = run()
    assert.equal(c.OTEL_ENABLED, false)
    assert.equal(c.OTEL_LOG_LEVEL, 'none')
    assert.equal(c.OTEL_SERVICE_NAME, c.service)
    assert.equal(c.OTEL_PROPAGATORS, 'datadog,tracecontext,baggage')
    assert.equal('OTEL_TRACES_SAMPLER' in c, false)
    assert.equal(c.OTEL_LOGS_EXPORTER, 'none')
    assert.equal('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT' in c, false)
  })

  it('reports effective defaults, signal overrides and actual protocol fallbacks', () => {
    const { configuration: c } = run({
      ...allSignals,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example/base',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=secret',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://logs.example/custom',
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: '1234',
    })
    assert.equal(c.OTEL_ENABLED, true)
    assert.equal(c.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, 'https://collector.example/base/v1/traces')
    assert.equal(c.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, 'https://collector.example/base/v1/metrics')
    assert.equal(c.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, 'https://logs.example/custom')
    assert.equal(c.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL, 'http/json')
    assert.equal(c.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL, 'http/protobuf')
    assert.equal(c.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL, 'http/json')
    assert.equal(c.OTEL_EXPORTER_OTLP_LOGS_TIMEOUT, 1234)
    assert.deepEqual(c.OTEL_EXPORTER_OTLP_LOGS_HEADERS, { authorization: '<redacted>' })
    assert.equal(c.OTEL_METRIC_EXPORT_INTERVAL, 10000)
    assert.equal(c.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE, 'delta')
    assert.equal(c.OTEL_BLRP_SCHEDULE_DELAY, 5000)
    assert.equal(c.OTEL_BLRP_MAX_EXPORT_BATCH_SIZE, 512)
    for (const name of ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_PROTOCOL',
      'OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_BLRP_MAX_QUEUE_SIZE', 'OTEL_BLRP_EXPORT_TIMEOUT']) {
      assert.equal(name in c, false, name)
    }
  })

  for (const signal of ['LOGS', 'METRICS']) {
    it(`initializes and reports ${signal.toLowerCase()} when tracing is disabled`, () => {
      const { configuration: c } = run({ DD_TRACE_ENABLED: 'false', [`DD_${signal}_OTEL_ENABLED`]: 'true' })
      assert.equal(c.OTEL_ENABLED, true)
      assert.equal(c.otlp_traces_export_enabled, false)
      assert.equal(c[`otlp_${signal.toLowerCase()}_export_enabled`], true)
      assert.equal(c[`OTEL_EXPORTER_OTLP_${signal}_PROTOCOL`], 'http/protobuf')
      assert.equal('OTEL_TRACES_SAMPLER' in c, false)
    })
  }

  for (const signal of ['LOGS', 'METRICS']) {
    for (const enabled of [undefined, 'false', 'true']) {
      it(`preserves the OTel trace opt-out with ${signal.toLowerCase()} and DD_TRACE_ENABLED=${enabled}`, () => {
        const { configuration: c, carrier } = run({
          OTEL_TRACES_EXPORTER: 'none',
          DD_TRACE_ENABLED: enabled,
          [`DD_${signal}_OTEL_ENABLED`]: 'true',
          OTEL_STARTUP_SAMPLE: 'true',
        })
        assert.equal(c[`otlp_${signal.toLowerCase()}_export_enabled`], true)
        assert.equal('OTEL_PROPAGATORS' in c, enabled === 'true')
        assert.equal(Object.keys(carrier).length > 0, enabled === 'true')
      })
    }
  }

  it('preserves the trace opt-out when the requested metrics pipeline is inactive', () => {
    const { configuration: c, carrier } = run({
      OTEL_TRACES_EXPORTER: 'none',
      DD_METRICS_OTEL_ENABLED: 'true',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_STARTUP_SAMPLE: 'true',
    })
    assert.equal(c.otlp_metrics_export_enabled, false)
    assert.equal(c.OTEL_ENABLED, false)
    assert.deepEqual(carrier, {})
  })

  it('reflects the existing exporter-enable decisions rather than the raw OTel selectors', () => {
    const { configuration: c } = run({
      DD_LOGS_OTEL_ENABLED: 'true',
      OTEL_LOGS_EXPORTER: 'none',
      DD_METRICS_OTEL_ENABLED: 'true',
      OTEL_METRICS_EXPORTER: 'none',
    })
    assert.equal(c.OTEL_LOGS_EXPORTER, 'otlp')
    assert.equal(c.otlp_logs_export_enabled, true)
    assert.equal(c.otlp_metrics_export_enabled, false)
    assert.equal('OTEL_METRIC_EXPORT_INTERVAL' in c, false)
  })

  it('does not advertise OTLP traces in CI or Electron', () => {
    for (const options of [{ isCiVisibility: true }, { experimental: { exporter: 'electron' } }]) {
      const { configuration: c } = run({ OTEL_TRACES_EXPORTER: 'otlp' }, options)
      assert.equal(c.otlp_traces_export_enabled, false)
      assert.equal('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT' in c, false)
    }
  })

  it('reports span-metrics transport without claiming that a MeterProvider is active', () => {
    const { configuration: c } = run({ OTEL_TRACES_SPAN_METRICS_ENABLED: 'true' })
    assert.equal(c.OTEL_ENABLED, true)
    assert.equal(c.OTEL_TRACES_SPAN_METRICS_ENABLED, true)
    assert.equal(c.otlp_metrics_export_enabled, false)
    assert.equal(c.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL, 'http/protobuf')
    assert.equal('OTEL_METRIC_EXPORT_INTERVAL' in c, false)
    assert.equal('OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE' in c, false)
  })

  for (const [rate, name] of [[0, 'always_off'], [0.25, 'traceidratio'], [1, 'always_on']]) {
    it(`reports the normalized parent-based sampler for rate ${rate}`, () => {
      const { configuration: c } = run({ OTEL_TRACES_SAMPLER: 'always_off' }, { sampleRate: rate })
      assert.equal(c.OTEL_TRACES_SAMPLER, `parentbased_${name}`)
      assert.equal(c.OTEL_TRACES_SAMPLER_ARG, rate === 0.25 ? rate : undefined)
    })
  }

  it('reports effective custom rules rather than the global fallback rate', () => {
    const { configuration: c } = run({}, { sampleRate: 1, samplingRules: [{ service: 'other', sampleRate: 0.2 }] })
    assert.equal(c.OTEL_TRACES_SAMPLER, 'datadog_custom_rules')
    assert.equal('OTEL_TRACES_SAMPLER_ARG' in c, false)
  })

  it('reports unconditional custom rules, including their sampling limits', () => {
    assert.equal(run({}, { samplingRules: [{ sampleRate: 0.25 }] })
      .configuration.OTEL_TRACES_SAMPLER, 'datadog_custom_rules')
    const result = run({
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_PROPAGATORS: 'tracecontext',
      OTEL_STARTUP_SAMPLE: 'true',
    }, { sampleRate: 1, samplingRules: [{ sampleRate: 1, maxPerSecond: 0 }] })
    assert.equal(result.configuration.OTEL_TRACES_SAMPLER, 'datadog_custom_rules')
    assert.equal('OTEL_TRACES_SAMPLER_ARG' in result.configuration, false)
    assert.equal(result.carrier.traceparent.split('-')[3], '00')
  })

  it('ignores invalid custom rules when reporting the effective global rate', () => {
    const { configuration: c } = run({}, { sampleRate: 0.25, samplingRules: [{ sampleRate: 'invalid' }] })
    assert.equal(c.OTEL_TRACES_SAMPLER, 'parentbased_traceidratio')
    assert.equal(c.OTEL_TRACES_SAMPLER_ARG, 0.25)
  })

  it('omits a fixed OTel sampler description for standalone sampling', () => {
    const { configuration: c } = run({ DD_APM_TRACING_ENABLED: 'false' })
    assert.equal('OTEL_TRACES_SAMPLER' in c, false)
    assert.equal('OTEL_TRACES_SAMPLER_ARG' in c, false)
  })

  it('reports matching propagators and omits asymmetric propagation', () => {
    const matching = run({ OTEL_PROPAGATORS: 'tracecontext,baggage' }).configuration
    assert.equal(matching.OTEL_PROPAGATORS, 'tracecontext,baggage')
    assert.equal(run({ OTEL_PROPAGATORS: 'none,baggage' }).configuration.OTEL_PROPAGATORS, 'baggage')
    assert.equal(run({}, { tracePropagationStyle: ['b3 single header', 'b3multi'] })
      .configuration.OTEL_PROPAGATORS, 'b3,b3multi')
    assert.equal(run({}, { tracePropagationStyle: [] }).configuration.OTEL_PROPAGATORS, 'none')
    assert.equal(run({}, { tracePropagationStyle: { inject: ['b3'], extract: ['tracecontext'] } })
      .configuration.OTEL_PROPAGATORS, undefined)
  })

  for (const styles of [['jaeger'], ['datadog', 'jaeger']]) {
    for (const source of ['environment', 'code']) {
      it(`omits unsupported propagators (${styles.join(',')}) from ${source} in startup and flare`, () => {
        const result = run({
          OTEL_STARTUP_SAMPLE: 'true',
          ...(source === 'environment' && {
            DD_TRACE_PROPAGATION_STYLE_INJECT: styles.join(','),
            DD_TRACE_PROPAGATION_STYLE_EXTRACT: styles.join(','),
          }),
        }, source === 'code' ? { tracePropagationStyle: styles } : {})
        // Reporting must preserve the existing injection behavior, including ignored names.
        if (styles.includes('datadog')) {
          assert.deepEqual(Object.keys(result.carrier).sort(), [
            'x-datadog-parent-id', 'x-datadog-sampling-priority', 'x-datadog-tags', 'x-datadog-trace-id',
          ])
        } else {
          assert.deepEqual(result.carrier, {})
        }
        assert.equal('OTEL_PROPAGATORS' in result.configuration, false)
        assert.equal('OTEL_PROPAGATORS' in result.flare, false)
      })
    }
  }

  for (const behavior of ['ignore', 'restart']) {
    it(`omits an OTel propagator description for extraction behavior ${behavior}`, () => {
      const { configuration: c } = run({
        OTEL_PROPAGATORS: 'tracecontext,baggage',
        DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT: behavior,
      })
      assert.equal('OTEL_PROPAGATORS' in c, false)
    })
  }

  for (const signal of ['metrics', 'logs']) {
    it(`does not claim an active ${signal} exporter when another provider owns the API`, () => {
      const result = run({
        [`DD_${signal.toUpperCase()}_OTEL_ENABLED`]: 'true',
        OTEL_STARTUP_EXISTING_PROVIDER: signal,
      })
      assert.equal(result.previousProviderStillActive, true)
      assert.equal(result.configuration[`otlp_${signal}_export_enabled`], false)
      assert.equal(`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_PROTOCOL` in result.configuration, false)
      assert.equal(result.configuration.OTEL_ENABLED, false)
    })
  }

  it('does not serialize user tags while capturing a disabled startup log', () => {
    const result = run({ OTEL_STARTUP_UNSAFE_TAG: 'true', DD_TRACE_DEBUG: 'true' }, { startupLogs: false })
    assert.equal(result.serializationCalls, 0)
    assert.deepEqual(result.errors, [])
    assert.equal(result.configuration, undefined)
  })

  it('snapshots only supported resource attribute values', () => {
    const { configuration: c } = run({}, {
      tags: { scalar: 42, list: ['initial'], object: { unsupported: true }, nested: [['unsupported']] },
    })
    assert.equal(c.OTEL_RESOURCE_ATTRIBUTES.scalar, 42)
    assert.deepEqual(c.OTEL_RESOURCE_ATTRIBUTES.list, ['initial'])
    assert.equal('object' in c.OTEL_RESOURCE_ATTRIBUTES, false)
    assert.equal('nested' in c.OTEL_RESOURCE_ATTRIBUTES, false)
  })

  for (const suffix of ['?api_key=secret', '#secret']) {
    it(`redacts endpoint ${suffix.startsWith('?') ? 'query' : 'fragment'} without userinfo`, () => {
      const result = run({
        DD_LOGS_OTEL_ENABLED: 'true',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `https://collector.example/logs${suffix}`,
      })
      assert.equal(result.configuration.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, 'https://collector.example/logs')
      assert.equal(result.flare.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, 'https://collector.example/logs')
      assert.doesNotMatch(JSON.stringify(result), /secret/)
    })
  }

  it('uses resolved code/DD precedence, service, tags and logger state', () => {
    const { configuration: c } = run({
      OTEL_SERVICE_NAME: 'otel-service',
      DD_SERVICE: 'dd-service',
      DD_ENV: 'test',
      DD_VERSION: '1.2.3',
      OTEL_RESOURCE_ATTRIBUTES: 'custom=otel',
      DD_TAGS: 'custom:dd',
      DD_TRACE_DEBUG: 'true',
      DD_TRACE_LOG_LEVEL: 'warn',
      OTEL_LOG_LEVEL: 'debug',
    }, { service: 'code-service', tags: { custom: 'code' } })
    assert.equal(c.OTEL_SERVICE_NAME, 'code-service')
    assert.equal(c.OTEL_RESOURCE_ATTRIBUTES.custom, 'code')
    assert.equal(c.OTEL_RESOURCE_ATTRIBUTES['deployment.environment.name'], 'test')
    assert.equal(c.OTEL_RESOURCE_ATTRIBUTES['service.version'], '1.2.3')
    assert.equal(c.OTEL_LOG_LEVEL, 'warn')
    assert.equal(run({ DD_TRACE_DEBUG: 'true', DD_TRACE_LOG_LEVEL: 'off' })
      .configuration.OTEL_LOG_LEVEL, 'debug')
  })

  it('keeps a sanitized startup snapshot in flare output after configuration changes', () => {
    const result = run({
      DD_LOGS_OTEL_ENABLED: 'true',
      OTEL_STARTUP_MUTATE: 'true',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://user:password@collector.example/logs?api_key=secret#token',
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: 'authorization=secret',
    }, { tags: { mutable: ['initial'] } })
    const otelFields = object => Object.fromEntries(Object.entries(object).filter(([key]) => /^OTEL_|^DD_/.test(key)))
    assert.deepEqual(otelFields(result.configuration), otelFields(result.flare))
    assert.equal(result.configuration.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, 'https://collector.example/logs')
    assert.equal(result.lines.filter(line => line.startsWith('DATADOG TRACER CONFIGURATION - ')).length, 1)
    assert.doesNotMatch(JSON.stringify(result), /password|api_key|secret|#token/)
  })

  it('honors startupLogs=false', () => {
    const result = run(allSignals, { startupLogs: false })
    assert.equal(result.configuration, undefined)
    assert.equal(result.flare.OTEL_ENABLED, true)
  })

  for (const scenario of [
    {
      name: 'DD environment variables override OTel inputs',
      env: {
        DD_ENV: 'dd-env',
        DD_VERSION: 'dd-version',
        OTEL_SERVICE_NAME: 'otel-service',
        OTEL_RESOURCE_ATTRIBUTES:
          'service.name=attribute-service,deployment.environment.name=otel-env,' +
          'service.version=otel-version,custom=otel',
      },
      service: 'wire-service',
      envName: 'dd-env',
      version: 'dd-version',
    },
    {
      name: 'OTel inputs supply unset DD values',
      env: {
        DD_SERVICE: undefined,
        OTEL_SERVICE_NAME: 'otel-service',
        OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment.name=otel-env,service.version=otel-version',
      },
      service: 'otel-service',
      envName: 'otel-env',
      version: 'otel-version',
    },
    {
      name: 'DD tags override OTel resource attributes',
      env: {
        DD_TAGS: 'custom:wire,env:dd-tag-env,version:dd-tag-version',
        OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment.name=otel-env,service.version=otel-version',
      },
      service: 'wire-service',
      envName: 'dd-tag-env',
      version: 'dd-tag-version',
    },
    {
      name: 'explicit programmatic resource keys retain existing exporter precedence',
      options: {
        env: 'code-env',
        version: 'code-version',
        tags: { custom: 'wire', 'deployment.environment.name': 'resource-env', 'service.version': 'resource-version' },
      },
      service: 'wire-service',
      envName: 'resource-env',
      version: 'resource-version',
    },
  ]) {
    it(`matches real OTLP transports and resource attributes: ${scenario.name}`, async () => {
      const received = new Map()
      let complete
      const requests = new Promise(resolve => { complete = resolve })
      const server = http.createServer((req, res) => {
        const chunks = []
        req.on('data', chunk => chunks.push(chunk))
        req.on('end', () => {
          const path = new URL(req.url ?? '/', 'http://collector').pathname
          received.set(path, { headers: req.headers, body: Buffer.concat(chunks) })
          res.writeHead(200).end('{}')
          if (received.size === 3) complete()
        })
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      const origin = `http://127.0.0.1:${address.port}`
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(DD_|_DD_|OTEL_)/.test(name)))
      const child = fork(fixture, [JSON.stringify(scenario.options ?? {})], {
        silent: true,
        env: {
          ...inherited,
          ...allSignals,
          OTEL_STARTUP_EMIT: 'true',
          OTEL_EXPORTER_OTLP_ENDPOINT: origin,
          OTEL_EXPORTER_OTLP_HEADERS: 'authorization=wire-secret',
          OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
          OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '1',
          OTEL_METRIC_EXPORT_INTERVAL: '25',
          DD_SERVICE: 'wire-service',
          DD_TAGS: 'custom:wire',
          ...scenario.env,
        },
      })
      assert.ok(child.stdout && child.stderr)
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      const exited = once(child, 'exit')
      let timeout
      try {
        await Promise.race([requests, new Promise((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(`Missing OTLP requests: ${stderr}`)), 10000)
        })])
        child.send('stop')
        await exited
        const { configuration: c } = JSON.parse(stdout.split('STARTUP_RESULT ')[1])
        assert.equal(c.OTEL_SERVICE_NAME, scenario.service)
        assert.equal(c.OTEL_RESOURCE_ATTRIBUTES['deployment.environment.name'], scenario.envName)
        assert.equal(c.OTEL_RESOURCE_ATTRIBUTES['service.version'], scenario.version)
        const { protoLogsService, protoMetricsService } = getProtobufTypes()
        for (const [signal, decoder, resourceKey] of [
          ['TRACES', undefined, 'resourceSpans'], ['LOGS', protoLogsService, 'resourceLogs'],
          ['METRICS', protoMetricsService, 'resourceMetrics'],
        ]) {
          const request = received.get(`/v1/${signal.toLowerCase()}`)
          assert.ok(request)
          assert.equal(c[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`], `${origin}/v1/${signal.toLowerCase()}`)
          assert.equal(request.headers.authorization, 'wire-secret')
          assert.deepEqual(c[`OTEL_EXPORTER_OTLP_${signal}_HEADERS`], { authorization: '<redacted>' })
          assert.equal(request.headers['content-type'], decoder ? 'application/x-protobuf' : 'application/json')
          const payload = decoder ? decoder.decode(request.body) : JSON.parse(request.body)
          const attributes = payload[resourceKey][0].resource.attributes
          assert.ok(attributes.some(attribute => attribute.key === 'service.name' &&
            attribute.value.stringValue === c.OTEL_SERVICE_NAME))
          for (const [key, value] of [
            ['deployment.environment.name', scenario.envName], ['service.version', scenario.version],
          ]) {
            assert.ok(attributes.some(attribute => attribute.key === key && attribute.value.stringValue === value), key)
          }
          assert.ok(attributes.some(attribute => attribute.key === 'custom' &&
            attribute.value.stringValue === c.OTEL_RESOURCE_ATTRIBUTES.custom))
        }
      } finally {
        clearTimeout(timeout)
        child.kill()
        await new Promise(resolve => server.close(resolve))
      }
    }).timeout(15000)
  }
})
