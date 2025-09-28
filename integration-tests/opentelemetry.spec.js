'use strict'

const { FakeAgent, createSandbox } = require('./helpers')
const { fork } = require('child_process')
const { join } = require('path')
const { assert } = require('chai')
const axios = require('axios')

async function check (agent, proc, timeout, onMessage = () => { }, isMetrics) {
  const messageReceiver = isMetrics
    ? agent.assertTelemetryReceived(onMessage, 'generate-metrics', timeout)
    : agent.assertMessageReceived(onMessage, timeout)

  const [res] = await Promise.all([
    messageReceiver,
    /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
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
    }))
  ])

  return res
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
      '@opentelemetry/api@1.8.0',
      '@opentelemetry/instrumentation',
      '@opentelemetry/instrumentation-http',
      '@opentelemetry/instrumentation-express@0.47.1',
      'express@4', // TODO: Remove pinning once our tests support Express v5
      '@opentelemetry/sdk-node',
      // Needed because sdk-node doesn't start a tracer without an exporter
      '@opentelemetry/exporter-jaeger'
    ]
    sandbox = await createSandbox(dependencies)
    cwd = sandbox.folder
    agent = await new FakeAgent().start()
  })

  after(async () => {
    proc.kill()
    await agent.stop()
    await sandbox.remove()
  })

  it("should not capture telemetry DD and OTEL vars don't conflict", async () => {
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

    await check(agent, proc, timeout, ({ payload }) => {
      assert.strictEqual(payload.request_type, 'generate-metrics')

      const metrics = payload.payload
      assert.strictEqual(metrics.namespace, 'tracers')

      const otelHiding = metrics.series.filter(({ metric }) => metric === 'otel.env.hiding')
      const otelInvalid = metrics.series.filter(({ metric }) => metric === 'otel.env.invalid')

      assert.strictEqual(otelHiding.length, 0)
      assert.strictEqual(otelInvalid.length, 0)
    }, true)
  })

  it('should capture telemetry if both DD and OTEL env vars are set', async () => {
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

    await check(agent, proc, timeout, ({ payload }) => {
      assert.strictEqual(payload.request_type, 'generate-metrics')

      const metrics = payload.payload

      assert.strictEqual(metrics.namespace, 'tracers')

      const otelHiding = metrics.series.filter(({ metric }) => metric === 'otel.env.hiding')
      const otelInvalid = metrics.series.filter(({ metric }) => metric === 'otel.env.invalid')
      assert.strictEqual(otelHiding.length, 9)
      assert.strictEqual(otelInvalid.length, 0)

      assert.deepStrictEqual(otelHiding[0].tags, [
        'config_datadog:dd_trace_log_level', 'config_opentelemetry:otel_log_level'
      ])
      assert.deepStrictEqual(otelHiding[1].tags, [
        'config_datadog:dd_trace_propagation_style', 'config_opentelemetry:otel_propagators'
      ])
      assert.deepStrictEqual(otelHiding[2].tags, [
        'config_datadog:dd_service', 'config_opentelemetry:otel_service_name'
      ])

      assert.deepStrictEqual(otelHiding[3].tags, [
        'config_datadog:dd_trace_sample_rate', 'config_opentelemetry:otel_traces_sampler'
      ])

      assert.deepStrictEqual(otelHiding[4].tags, [
        'config_datadog:dd_trace_sample_rate', 'config_opentelemetry:otel_traces_sampler_arg'
      ])

      assert.deepStrictEqual(otelHiding[5].tags, [
        'config_datadog:dd_trace_enabled', 'config_opentelemetry:otel_traces_exporter'
      ])

      assert.deepStrictEqual(otelHiding[6].tags, [
        'config_datadog:dd_runtime_metrics_enabled', 'config_opentelemetry:otel_metrics_exporter'
      ])

      assert.deepStrictEqual(otelHiding[7].tags, [
        'config_datadog:dd_tags', 'config_opentelemetry:otel_resource_attributes'
      ])

      assert.deepStrictEqual(otelHiding[8].tags, [
        'config_datadog:dd_trace_otel_enabled', 'config_opentelemetry:otel_sdk_disabled'
      ])

      for (const metric of otelHiding) {
        assert.strictEqual(metric.points[0][1], 1)
      }
    }, true)
  })

  it('should capture telemetry when OTEL env vars are invalid', async () => {
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

    await check(agent, proc, timeout, ({ payload }) => {
      assert.strictEqual(payload.request_type, 'generate-metrics')

      const metrics = payload.payload

      assert.strictEqual(metrics.namespace, 'tracers')

      const otelHiding = metrics.series.filter(({ metric }) => metric === 'otel.env.hiding')
      const otelInvalid = metrics.series.filter(({ metric }) => metric === 'otel.env.invalid')

      assert.strictEqual(otelHiding.length, 1)
      assert.strictEqual(otelInvalid.length, 8)

      assert.deepStrictEqual(otelHiding[0].tags, [
        'config_datadog:dd_trace_otel_enabled', 'config_opentelemetry:otel_sdk_disabled'
      ])

      assert.deepStrictEqual(otelInvalid[0].tags, [
        'config_datadog:dd_trace_log_level', 'config_opentelemetry:otel_log_level'
      ])

      assert.deepStrictEqual(otelInvalid[1].tags, [
        'config_datadog:dd_trace_sample_rate',
        'config_opentelemetry:otel_traces_sampler'
      ])

      assert.deepStrictEqual(otelInvalid[2].tags, [
        'config_datadog:dd_trace_sample_rate',
        'config_opentelemetry:otel_traces_sampler_arg'
      ])
      assert.deepStrictEqual(otelInvalid[3].tags, [
        'config_datadog:dd_trace_enabled', 'config_opentelemetry:otel_traces_exporter'
      ])

      assert.deepStrictEqual(otelInvalid[4].tags, [
        'config_datadog:dd_runtime_metrics_enabled',
        'config_opentelemetry:otel_metrics_exporter'
      ])

      assert.deepStrictEqual(otelInvalid[5].tags, [
        'config_datadog:dd_trace_otel_enabled', 'config_opentelemetry:otel_sdk_disabled'
      ])

      assert.deepStrictEqual(otelInvalid[6].tags, [
        'config_opentelemetry:otel_logs_exporter'
      ])

      assert.deepStrictEqual(otelInvalid[7].tags, [
        'config_datadog:dd_trace_propagation_style',
        'config_opentelemetry:otel_propagators'
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
    await check(agent, proc, timeout, ({ payload }) => {
      // Should have a single trace with a single span
      assert.strictEqual(payload.length, 1)
      const [trace] = payload
      assert.strictEqual(trace.length, 1)
      const [span] = trace

      // Should be the expected otel span
      assert.strictEqual(span.name, 'otel-sub')
    })
  })

  it('should capture telemetry', async () => {
    proc = fork(join(cwd, 'opentelemetry/basic.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_TRACE_OTEL_ENABLED: 1,
        DD_TELEMETRY_HEARTBEAT_INTERVAL: 1,
        TIMEOUT: 1500
      }
    })

    await check(agent, proc, timeout, ({ payload }) => {
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
          'otel_enabled:true'
        ])
      }
    }, true)
  })

  it('should capture auto-instrumentation telemetry', async () => {
    const SERVER_PORT = 6666
    proc = fork(join(cwd, 'opentelemetry/auto-instrumentation.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_TRACE_OTEL_ENABLED: 1,
        SERVER_PORT,
        DD_TRACE_DISABLED_INSTRUMENTATIONS: 'http,dns,express,net',
        DD_TELEMETRY_HEARTBEAT_INTERVAL: 1
      }
    })
    await new Promise(resolve => setTimeout(resolve, 1000)) // Adjust the delay as necessary
    await axios.get(`http://localhost:${SERVER_PORT}/first-endpoint`)

    await check(agent, proc, 10000, ({ payload }) => {
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
        assert.strictEqual(value, 9)

        assert.strictEqual(series.type, 'count')
        assert.strictEqual(series.common, true)
        assert.deepStrictEqual(series.tags, [
          'integration_name:otel.library',
          'otel_enabled:true'
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
    await check(agent, proc, timeout, ({ payload }) => {
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

  it('should work with otel express & http auto instrumentation', async () => {
    const SERVER_PORT = 6666
    proc = fork(join(cwd, 'opentelemetry/auto-instrumentation.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_TRACE_OTEL_ENABLED: 1,
        SERVER_PORT,
        DD_TRACE_DISABLED_INSTRUMENTATIONS: 'http,dns,express,net'
      }
    })
    await new Promise(resolve => setTimeout(resolve, 1000)) // Adjust the delay as necessary
    await axios.get(`http://localhost:${SERVER_PORT}/first-endpoint`)

    await check(agent, proc, 10000, ({ payload }) => {
      assert.strictEqual(payload.length, 2)
      // combine the traces
      const trace = payload.flat()
      assert.strictEqual(trace.length, 9)

      // Should have expected span names and ordering
      assert.isTrue(eachEqual(trace, [
        'GET /second-endpoint',
        'middleware - query',
        'middleware - expressInit',
        'request handler - /second-endpoint',
        'GET /first-endpoint',
        'middleware - query',
        'middleware - expressInit',
        'request handler - /first-endpoint',
        'GET'
      ],
      (span) => span.name))

      assert.isTrue(allEqual(trace, (span) => {
        span.trace_id.toString()
      }))

      const [get3, query2, init2, handler2, get1, query1, init1, handler1, get2] = trace
      isChildOf(query1, get1)
      isChildOf(init1, get1)
      isChildOf(handler1, get1)
      isChildOf(get2, get1)
      isChildOf(get3, get2)
      isChildOf(query2, get3)
      isChildOf(init2, get3)
      isChildOf(handler2, get3)
    })
  })

  it('should auto-instrument @opentelemetry/sdk-node', async () => {
    proc = fork(join(cwd, 'opentelemetry/env-var.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port
      }
    })
    await check(agent, proc, timeout, ({ payload }) => {
      // Should have a single trace with a single span
      assert.strictEqual(payload.length, 1)
      const [trace] = payload
      assert.strictEqual(trace.length, 1)
      const [span] = trace

      // Should be the expected otel span
      assert.strictEqual(span.name, 'otel-sub')
    })
  })
})

function isChildOf (childSpan, parentSpan) {
  assert.strictEqual(childSpan.trace_id.toString(), parentSpan.trace_id.toString())
  assert.notStrictEqual(childSpan.span_id.toString(), parentSpan.span_id.toString())
  assert.strictEqual(childSpan.parent_id.toString(), parentSpan.span_id.toString())
}
