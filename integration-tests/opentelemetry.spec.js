'use strict'

const assert = require('node:assert/strict')

const { fork } = require('child_process')
const { join } = require('path')
const axios = require('axios')
const { FakeAgent, sandboxCwd, useSandbox, stopProc } = require('./helpers')

// NYC instrumentation slows child-process bootstrap (dd-trace init, OTel provider
// registration, Express `listen`), so the three tests below need longer waits for
// telemetry and for the fixture HTTP server to be reachable. All other tests in this
// file already pass with the default timeouts and are left untouched.
const COVERAGE_ACTIVE = Boolean(process.env.DD_TRACE_INTEGRATION_COVERAGE_ROOT)
// Chosen empirically as the smallest multiplier that keeps the failing tests stable on
// both local runs and CI (observed overhead ~2x wall-clock). Prefer reusing this constant
// when making other tests coverage-aware so the safety margin stays uniform and minimal.
const COVERAGE_SLOWDOWN = COVERAGE_ACTIVE ? 2 : 1

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
    })),
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

describe('opentelemetry', function () {
  this.timeout(20_000 * COVERAGE_SLOWDOWN)

  let agent = /** @type {FakeAgent | null} */ (null)
  let proc
  let cwd = /** @type {string} */ ('')
  const timeout = 5000
  const dependencies = [
    '@opentelemetry/api@1.8.0',
    '@opentelemetry/instrumentation',
    '@opentelemetry/instrumentation-http',
    '@opentelemetry/instrumentation-express@0.47.1',
    'express@4', // TODO: Remove pinning once our tests support Express v5
    '@opentelemetry/sdk-node',
    // Needed because sdk-node doesn't start a tracer without an exporter
    '@opentelemetry/exporter-jaeger',
  ]

  useSandbox(dependencies)

  before(async () => {
    cwd = sandboxCwd()
    agent = await new FakeAgent().start()
  })

  after(async () => {
    await stopProc(proc)
    await agent?.stop()
  })

  it("should not capture telemetry DD and OTEL vars don't conflict", async () => {
    proc = fork(join(cwd, 'opentelemetry/basic.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent?.port,
        DD_TRACE_OTEL_ENABLED: '1',
        DD_TELEMETRY_HEARTBEAT_INTERVAL: '1',
        TIMEOUT: '1500',
        DD_SERVICE: 'service',
        DD_TRACE_LOG_LEVEL: 'error',
        DD_TRACE_SAMPLE_RATE: '0.5',
        DD_TRACE_ENABLED: 'true',
        DD_RUNTIME_METRICS_ENABLED: 'true',
        DD_TAGS: 'foo:bar,baz:qux',
        DD_TRACE_PROPAGATION_STYLE: 'datadog',
      },
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
        DD_TRACE_AGENT_PORT: agent?.port,
        DD_TRACE_OTEL_ENABLED: '1',
        DD_TELEMETRY_HEARTBEAT_INTERVAL: '1',
        TIMEOUT: '1500',
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
        OTEL_SDK_DISABLED: 'false',
      },
    })

    await check(agent, proc, timeout, ({ payload }) => {
      assert.strictEqual(payload.request_type, 'generate-metrics')

      const metrics = payload.payload

      assert.strictEqual(metrics.namespace, 'tracers')

      const otelHiding = metrics.series.filter(({ metric }) => metric === 'otel.env.hiding')
      const otelInvalid = metrics.series.filter(({ metric }) => metric === 'otel.env.invalid')

      assert.deepStrictEqual(sortMetricTags(otelHiding), sortMetricTags([
        ['config_datadog:dd_trace_log_level', 'config_opentelemetry:otel_log_level'],
        ['config_datadog:dd_trace_propagation_style', 'config_opentelemetry:otel_propagators'],
        ['config_datadog:dd_service', 'config_opentelemetry:otel_service_name'],
        ['config_datadog:dd_trace_sample_rate', 'config_opentelemetry:otel_traces_sampler'],
        ['config_datadog:dd_trace_sample_rate', 'config_opentelemetry:otel_traces_sampler_arg'],
        ['config_datadog:dd_trace_enabled', 'config_opentelemetry:otel_traces_exporter'],
        ['config_datadog:dd_runtime_metrics_enabled', 'config_opentelemetry:otel_metrics_exporter'],
        ['config_datadog:dd_tags', 'config_opentelemetry:otel_resource_attributes'],
        ['config_datadog:dd_trace_otel_enabled', 'config_opentelemetry:otel_sdk_disabled'],
      ]))

      assert.deepStrictEqual(sortMetricTags(otelInvalid), [])

      for (const metric of otelHiding) {
        assert.strictEqual(metric.points[0][1], 1)
      }
    }, true)
  })

  it('should capture telemetry when OTEL env vars are invalid', async () => {
    proc = fork(join(cwd, 'opentelemetry/basic.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent?.port,
        DD_TRACE_OTEL_ENABLED: '1',
        DD_TELEMETRY_HEARTBEAT_INTERVAL: '1',
        TIMEOUT: '1500',
        OTEL_SERVICE_NAME: 'otel_service',
        OTEL_LOG_LEVEL: 'foo',
        OTEL_TRACES_SAMPLER: 'foo',
        OTEL_TRACES_SAMPLER_ARG: 'foo',
        OTEL_TRACES_EXPORTER: 'foo',
        OTEL_METRICS_EXPORTER: 'foo',
        OTEL_RESOURCE_ATTRIBUTES: 'foo',
        OTEL_PROPAGATORS: 'foo',
        OTEL_LOGS_EXPORTER: 'foo',
        OTEL_SDK_DISABLED: 'foo',
      },
    })

    await check(agent, proc, timeout, ({ payload }) => {
      assert.strictEqual(payload.request_type, 'generate-metrics')

      const metrics = payload.payload

      assert.strictEqual(metrics.namespace, 'tracers')

      const otelHiding = metrics.series.filter(({ metric }) => metric === 'otel.env.hiding')
      const otelInvalid = metrics.series.filter(({ metric }) => metric === 'otel.env.invalid')

      assert.deepStrictEqual(sortMetricTags(otelHiding), sortMetricTags([
        ['config_datadog:dd_trace_otel_enabled', 'config_opentelemetry:otel_sdk_disabled'],
      ]))

      assert.deepStrictEqual(sortMetricTags(otelInvalid), sortMetricTags([
        ['config_datadog:dd_trace_log_level', 'config_opentelemetry:otel_log_level'],
        ['config_datadog:dd_trace_propagation_style', 'config_opentelemetry:otel_propagators'],
        ['config_opentelemetry:otel_logs_exporter'],
        ['config_datadog:dd_trace_sample_rate', 'config_opentelemetry:otel_traces_sampler'],
        ['config_datadog:dd_trace_sample_rate', 'config_opentelemetry:otel_traces_sampler_arg'],
        ['config_datadog:dd_trace_enabled', 'config_opentelemetry:otel_traces_exporter'],
        ['config_datadog:dd_runtime_metrics_enabled', 'config_opentelemetry:otel_metrics_exporter'],
        ['config_datadog:dd_trace_otel_enabled', 'config_opentelemetry:otel_sdk_disabled'],
      ]))

      for (const metric of otelInvalid) {
        assert.strictEqual(metric.points[0][1], 1)
      }
    }, true)
  })

  it('should start a trace in isolation', async () => {
    proc = fork(join(cwd, 'opentelemetry/basic.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent?.port,
      },
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
    // Under coverage, dd-trace/OTel init in the child pushes the first telemetry
    // heartbeat past the default 5s `check` timeout; give `timeout` and the child's
    // hold window the same uniform slowdown so a heartbeat with `spans_*` lands in time.
    proc = fork(join(cwd, 'opentelemetry/basic.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent?.port,
        DD_TRACE_OTEL_ENABLED: '1',
        DD_TELEMETRY_HEARTBEAT_INTERVAL: '1',
        TIMEOUT: String(1500 * COVERAGE_SLOWDOWN),
      },
    })

    await check(agent, proc, timeout * COVERAGE_SLOWDOWN, ({ payload }) => {
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
        ])
      }
    }, true)
  })

  it('should capture auto-instrumentation telemetry', async () => {
    const SERVER_PORT = 6666
    proc = fork(join(cwd, 'opentelemetry/auto-instrumentation.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent?.port,
        DD_TRACE_OTEL_ENABLED: '1',
        SERVER_PORT,
        DD_TRACE_DISABLED_INSTRUMENTATIONS: 'http,dns,express,net',
        DD_TELEMETRY_HEARTBEAT_INTERVAL: '1',
      },
    })
    // 1s isn't enough for the NYC-instrumented child to finish `require` chains and
    // reach `app.listen()` before axios connects — bump the wait uniformly under coverage
    // so `axios.get` doesn't hit ECONNREFUSED.
    await new Promise(resolve => setTimeout(resolve, 1000 * COVERAGE_SLOWDOWN))
    await axios.get(`http://localhost:${SERVER_PORT}/first-endpoint`)

    await check(agent, proc, 10_000 * COVERAGE_SLOWDOWN, ({ payload }) => {
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
          'otel_enabled:true',
        ])
      }
    }, true)
  })

  it('should work within existing datadog-traced http request', async () => {
    proc = fork(join(cwd, 'opentelemetry/server.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent?.port,
      },
    })
    await check(agent, proc, timeout, ({ payload }) => {
      // Should have three spans
      const [trace] = payload
      assert.strictEqual(trace.length, 3)

      // Should have expected span names and ordering
      assert.strictEqual(eachEqual(trace, ['web.request', 'otel-sub', 'dd-sub'], span => span.name), true)

      // Should have matching trace ids
      assert.ok(allEqual(trace, span => span.trace_id.toString()))

      // Should have matching service names
      assert.strictEqual(allEqual(trace, span => span.service), true)

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
        DD_TRACE_AGENT_PORT: agent?.port,
        DD_TRACE_OTEL_ENABLED: '1',
        SERVER_PORT,
        DD_TRACE_DISABLED_INSTRUMENTATIONS: 'http,dns,express,net',
      },
    })
    // See note in "should capture auto-instrumentation telemetry": coverage-instrumented
    // child boot is too slow for the 1s default before `app.listen()` is ready.
    await new Promise(resolve => setTimeout(resolve, 1000 * COVERAGE_SLOWDOWN))
    await axios.get(`http://localhost:${SERVER_PORT}/first-endpoint`)

    await check(agent, proc, 10_000 * COVERAGE_SLOWDOWN, ({ payload }) => {
      assert.strictEqual(payload.length, 2)
      // combine the traces
      const trace = payload.flat()
      assert.strictEqual(trace.length, 9)

      // Should have expected span names and ordering
      assert.ok(eachEqual(trace, [
        'GET /second-endpoint',
        'middleware - query',
        'middleware - expressInit',
        'request handler - /second-endpoint',
        'GET /first-endpoint',
        'middleware - query',
        'middleware - expressInit',
        'request handler - /first-endpoint',
        'GET',
      ],
      (span) => span.name))

      assert.ok(allEqual(trace, (span) => {
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
        DD_TRACE_AGENT_PORT: agent?.port,
      },
    })
    await check(agent, proc, timeout, ({ payload }) => {
      const trace = payload.find(trace => trace.length === 1 && trace[0].name === 'otel-sub')
      assert.ok(trace)
    })
  })
})

function isChildOf (childSpan, parentSpan) {
  assert.strictEqual(childSpan.trace_id.toString(), parentSpan.trace_id.toString())
  assert.notStrictEqual(childSpan.span_id.toString(), parentSpan.span_id.toString())
  assert.strictEqual(childSpan.parent_id.toString(), parentSpan.span_id.toString())
}

function sortMetricTags (metrics) {
  return metrics
    .map(metric => Array.isArray(metric) ? metric : metric.tags)
    .sort((a, b) => a.join(',').localeCompare(b.join(',')))
}
