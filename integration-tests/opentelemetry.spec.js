'use strict'

const { FakeAgent, createSandbox } = require('./helpers')
const { fork } = require('child_process')
const { join } = require('path')
const { assert } = require('chai')
const { satisfies } = require('semver')

function check (agent, proc, timeout, onMessage = () => { }, isMetrics) {
  const messageReceiver = isMetrics
    ? agent.assertTelemetryReceived(onMessage, timeout, 'generate-metrics')
    : agent.assertMessageReceived(onMessage, timeout)

  return Promise.all([
    messageReceiver,
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Process timed out'))
      }, timeout)

      proc
        .on('error', reject)
        .on('exit', (code) => {
          clearTimeout(timer)

          if (code !== 0) {
            reject(new Error(`Process exited with unexpected status code ${code}.`))
          } else {
            resolve()
          }
        })
    })
  ]).then(([res]) => res)
}

function allEqual (spans, fn) {
  const first = fn(spans[0])
  return spans.every(span => fn(span) === first)
}

function eachEqual (spans, expected, fn) {
  return spans.every((span, i) => fn(span) === expected[i])
}

function nearNow (ts, now = Date.now(), range = 1000) {
  const delta = Math.abs(now - ts)
  return delta < range && delta >= 0
}

describe('opentelemetry', () => {
  let agent
  let proc
  let sandbox
  let cwd
  const timeout = 5000

  before(async () => {
    const dependencies = [
      '@opentelemetry/api@1.8.0'
    ]
    if (satisfies(process.version.slice(1), '>=14')) {
      dependencies.push('@opentelemetry/sdk-node')
      // Needed because sdk-node doesn't start a tracer without an exporter
      dependencies.push('@opentelemetry/exporter-jaeger')
    }
    sandbox = await createSandbox(dependencies)
    cwd = sandbox.folder
    agent = await new FakeAgent().start()
  })

  after(async () => {
    proc.kill()
    await agent.stop()
    await sandbox.remove()
  })

  it('should not capture telemetry DD and OTEL vars dont conflict', () => {
    proc = fork(join(cwd, 'opentelemetry/basic.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_TRACE_OTEL_ENABLED: 1,
        DD_TELEMETRY_HEARTBEAT_INTERVAL: 1,
        TIMEOUT: 1500,
        DD_SERVICE: 'service',
        DD_TRACE_LOG_LEVEL: 'error',
        DD_TRACE_SAMPLE_RATE: '0.5',
        DD_TRACE_ENABLED: 'true',
        DD_RUNTIME_METRICS_ENABLED: 'true',
        DD_TAGS: 'foo:bar,baz:qux',
        DD_TRACE_PROPAGATION_STYLE: 'datadog'
      }
    })

    return check(agent, proc, timeout, ({ payload }) => {
      assert.strictEqual(payload.request_type, 'generate-metrics')

      const metrics = payload.payload
      assert.strictEqual(metrics.namespace, 'tracers')

      const otelHiding = metrics.series.filter(({ metric }) => metric === 'otel.env.hiding')
      const otelInvalid = metrics.series.filter(({ metric }) => metric === 'otel.env.invalid')

      assert.strictEqual(otelHiding.length, 0)
      assert.strictEqual(otelInvalid.length, 0)
    }, true)
  })

  it('should capture telemetry if both DD and OTEL env vars are set', () => {
    proc = fork(join(cwd, 'opentelemetry/basic.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_TRACE_OTEL_ENABLED: 1,
        DD_TELEMETRY_HEARTBEAT_INTERVAL: 1,
        TIMEOUT: 1500,
        DD_SERVICE: 'service',
        OTEL_SERVICE_NAME: 'otel_service',
        DD_TRACE_LOG_LEVEL: 'error',
        OTEL_LOG_LEVEL: 'debug',
        DD_TRACE_SAMPLE_RATE: '0.5',
        OTEL_TRACES_SAMPLER: 'traceidratio',
        OTEL_TRACES_SAMPLER_ARG: '1.0',
        DD_TRACE_ENABLED: 'true',
        OTEL_TRACES_EXPORTER: 'none',
        DD_RUNTIME_METRICS_ENABLED: 'true',
        OTEL_METRICS_EXPORTER: 'none',
        DD_TAGS: 'foo:bar,baz:qux',
        OTEL_RESOURCE_ATTRIBUTES: 'foo+bar13baz+qux1',
        DD_TRACE_PROPAGATION_STYLE: 'datadog, tracecontext',
        OTEL_PROPAGATORS: 'datadog, tracecontext',
        OTEL_LOGS_EXPORTER: 'none',
        OTEL_SDK_DISABLED: 'false'
      }
    })

    return check(agent, proc, timeout, ({ payload }) => {
      assert.strictEqual(payload.request_type, 'generate-metrics')

      const metrics = payload.payload

      assert.strictEqual(metrics.namespace, 'tracers')

      const otelHiding = metrics.series.filter(({ metric }) => metric === 'otel.env.hiding')
      const otelInvalid = metrics.series.filter(({ metric }) => metric === 'otel.env.invalid')
      assert.strictEqual(otelHiding.length, 9)
      assert.strictEqual(otelInvalid.length, 0)

      assert.deepStrictEqual(otelHiding[0].tags, [
        'config.datadog:DD_TRACE_LOG_LEVEL', 'config.opentelemetry:OTEL_LOG_LEVEL',
        `version:${process.version}`
      ])
      assert.deepStrictEqual(otelHiding[1].tags, [
        'config.datadog:DD_TRACE_PROPAGATION_STYLE', 'config.opentelemetry:OTEL_PROPAGATORS',
        `version:${process.version}`
      ])
      assert.deepStrictEqual(otelHiding[2].tags, [
        'config.datadog:DD_SERVICE', 'config.opentelemetry:OTEL_SERVICE_NAME',
        `version:${process.version}`
      ])

      assert.deepStrictEqual(otelHiding[3].tags, [
        'config.datadog:DD_TRACE_SAMPLE_RATE', 'config.opentelemetry:OTEL_TRACES_SAMPLER', `version:${process.version}`
      ])

      assert.deepStrictEqual(otelHiding[4].tags, [
        'config.datadog:DD_TRACE_SAMPLE_RATE', 'config.opentelemetry:OTEL_TRACES_SAMPLER_ARG',
        `version:${process.version}`
      ])

      assert.deepStrictEqual(otelHiding[5].tags, [
        'config.datadog:DD_TRACE_ENABLED', 'config.opentelemetry:OTEL_TRACES_EXPORTER',
        `version:${process.version}`
      ])

      assert.deepStrictEqual(otelHiding[6].tags, [
        'config.datadog:DD_RUNTIME_METRICS_ENABLED', 'config.opentelemetry:OTEL_METRICS_EXPORTER',
        `version:${process.version}`
      ])

      assert.deepStrictEqual(otelHiding[7].tags, [
        'config.datadog:DD_TAGS', 'config.opentelemetry:OTEL_RESOURCE_ATTRIBUTES',
        `version:${process.version}`
      ])

      assert.deepStrictEqual(otelHiding[8].tags, [
        'config.datadog:DD_TRACE_OTEL_ENABLED', 'config.opentelemetry:OTEL_SDK_DISABLED',
        `version:${process.version}`
      ])

      for (const metric of otelHiding) {
        assert.strictEqual(metric.points[0][1], 1)
      }
    }, true)
  })

  it('should capture telemetry when OTEL env vars are invalid', () => {
    proc = fork(join(cwd, 'opentelemetry/basic.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_TRACE_OTEL_ENABLED: 1,
        DD_TELEMETRY_HEARTBEAT_INTERVAL: 1,
        TIMEOUT: 1500,
        OTEL_SERVICE_NAME: 'otel_service',
        OTEL_LOG_LEVEL: 'foo',
        OTEL_TRACES_SAMPLER: 'foo',
        OTEL_TRACES_SAMPLER_ARG: 'foo',
        OTEL_TRACES_EXPORTER: 'foo',
        OTEL_METRICS_EXPORTER: 'foo',
        OTEL_RESOURCE_ATTRIBUTES: 'foo',
        OTEL_PROPAGATORS: 'foo',
        OTEL_LOGS_EXPORTER: 'foo',
        OTEL_SDK_DISABLED: 'foo'
      }
    })

    return check(agent, proc, timeout, ({ payload }) => {
      assert.strictEqual(payload.request_type, 'generate-metrics')

      const metrics = payload.payload

      assert.strictEqual(metrics.namespace, 'tracers')

      const otelHiding = metrics.series.filter(({ metric }) => metric === 'otel.env.hiding')
      const otelInvalid = metrics.series.filter(({ metric }) => metric === 'otel.env.invalid')

      assert.strictEqual(otelHiding.length, 1)
      assert.strictEqual(otelInvalid.length, 8)

      assert.deepStrictEqual(otelHiding[0].tags, [
        'config.datadog:DD_TRACE_OTEL_ENABLED', 'config.opentelemetry:OTEL_SDK_DISABLED',
        `version:${process.version}`
      ])

      assert.deepStrictEqual(otelInvalid[0].tags, [
        'config.datadog:DD_TRACE_LOG_LEVEL', 'config.opentelemetry:OTEL_LOG_LEVEL',
        `version:${process.version}`
      ])

      assert.deepStrictEqual(otelInvalid[1].tags, [
        'config.datadog:DD_TRACE_SAMPLE_RATE',
        'config.opentelemetry:OTEL_TRACES_SAMPLER',
        `version:${process.version}`
      ])

      assert.deepStrictEqual(otelInvalid[2].tags, [
        'config.datadog:DD_TRACE_SAMPLE_RATE',
        'config.opentelemetry:OTEL_TRACES_SAMPLER_ARG',
        `version:${process.version}`
      ])
      assert.deepStrictEqual(otelInvalid[3].tags, [
        'config.datadog:DD_TRACE_ENABLED', 'config.opentelemetry:OTEL_TRACES_EXPORTER',
        `version:${process.version}`
      ])

      assert.deepStrictEqual(otelInvalid[4].tags, [
        'config.datadog:DD_RUNTIME_METRICS_ENABLED',
        'config.opentelemetry:OTEL_METRICS_EXPORTER',
        `version:${process.version}`
      ])

      assert.deepStrictEqual(otelInvalid[5].tags, [
        'config.datadog:DD_TRACE_OTEL_ENABLED', 'config.opentelemetry:OTEL_SDK_DISABLED',
        `version:${process.version}`
      ])

      assert.deepStrictEqual(otelInvalid[6].tags, [
        'config.opentelemetry:OTEL_LOGS_EXPORTER',
        `version:${process.version}`
      ])

      assert.deepStrictEqual(otelInvalid[7].tags, [
        'config.datadog:DD_TRACE_PROPAGATION_STYLE',
        'config.opentelemetry:OTEL_PROPAGATORS',
        `version:${process.version}`
      ])

      for (const metric of otelInvalid) {
        assert.strictEqual(metric.points[0][1], 1)
      }
    }, true)
  })

  it('should start a trace in isolation', async () => {
    proc = fork(join(cwd, 'opentelemetry/basic.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port
      }
    })
    return check(agent, proc, timeout, ({ payload }) => {
      // Should have a single trace with a single span
      assert.strictEqual(payload.length, 1)
      const [trace] = payload
      assert.strictEqual(trace.length, 1)
      const [span] = trace

      // Should be the expected otel span
      assert.strictEqual(span.name, 'otel-sub')
    })
  })

  it('should capture telemetry', () => {
    proc = fork(join(cwd, 'opentelemetry/basic.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_TRACE_OTEL_ENABLED: 1,
        DD_TELEMETRY_HEARTBEAT_INTERVAL: 1,
        TIMEOUT: 1500
      }
    })

    return check(agent, proc, timeout, ({ payload }) => {
      assert.strictEqual(payload.request_type, 'generate-metrics')

      const metrics = payload.payload
      assert.strictEqual(metrics.namespace, 'tracers')

      const spanCreated = metrics.series.find(({ metric }) => metric === 'spans_created')
      const spanFinished = metrics.series.find(({ metric }) => metric === 'spans_finished')

      // Validate common fields between start and finish
      for (const series of [spanCreated, spanFinished]) {
        assert.ok(series)

        assert.strictEqual(series.points.length, 1)
        assert.strictEqual(series.points[0].length, 2)

        const [ts, value] = series.points[0]
        assert.ok(nearNow(ts, Date.now() / 1e3))
        assert.strictEqual(value, 1)

        assert.strictEqual(series.type, 'count')
        assert.strictEqual(series.common, true)
        assert.deepStrictEqual(series.tags, [
          'integration_name:otel',
          'otel_enabled:true',
          `version:${process.version}`
        ])
      }
    }, true)
  })

  it('should work within existing datadog-traced http request', async () => {
    proc = fork(join(cwd, 'opentelemetry/server.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port
      }
    })
    return check(agent, proc, timeout, ({ payload }) => {
      // Should have three spans
      const [trace] = payload
      assert.strictEqual(trace.length, 3)

      // Should have expected span names and ordering
      assert.isTrue(eachEqual(trace, ['web.request', 'otel-sub', 'dd-sub'], span => span.name))

      // Should have matching trace ids
      assert.isTrue(allEqual(trace, span => span.trace_id.toString()))

      // Should have matching service names
      assert.isTrue(allEqual(trace, span => span.service))

      // Should have expected span parentage
      const [webSpan, otelSpan, ddSpan] = trace
      assert.strictEqual(otelSpan.parent_id.toString(), webSpan.span_id.toString())
      assert.strictEqual(ddSpan.parent_id.toString(), otelSpan.span_id.toString())
    })
  })

  if (satisfies(process.version.slice(1), '>=14')) {
    it('should auto-instrument @opentelemetry/sdk-node', async () => {
      proc = fork(join(cwd, 'opentelemetry/env-var.js'), {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port
        }
      })
      return check(agent, proc, timeout, ({ payload }) => {
        // Should have a single trace with a single span
        assert.strictEqual(payload.length, 1)
        const [trace] = payload
        assert.strictEqual(trace.length, 1)
        const [span] = trace

        // Should be the expected otel span
        assert.strictEqual(span.name, 'otel-sub')
      })
    })
  }
})
