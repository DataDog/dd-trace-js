'use strict'

const assert = require('node:assert/strict')

const { fork } = require('child_process')
const { join } = require('path')
const axios = require('axios')
const { FakeAgent, sandboxCwd, useSandbox, stopProc } = require('./helpers')

async function check (agent, proc, timeout, onMessage = () => { }, isMetrics) {
  const messageReceiver = isMetrics
    ? agent.assertTelemetryReceived({ fn: onMessage, requestType: 'generate-metrics', timeout })
    : agent.assertMessageReceived(onMessage, timeout)

  const [res] = await Promise.all([messageReceiver, waitForExit(proc, timeout)])

  return res
}

/**
 * @param {import('child_process').ChildProcess} proc
 * @param {number} timeout
 * @returns {Promise<void>}
 */
function waitForExit (proc, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Process timed out'))
    }, timeout)

    proc
      .on('error', reject)
      .on('exit', (code) => {
        clearTimeout(timer)

        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`Process exited with unexpected status code ${code}.`))
        }
      })
  })
}

/**
 * Collects spans from the fake agent's OTLP receiver until `count` have arrived.
 *
 * @param {import('./helpers').FakeAgent} agent
 * @param {number} count
 * @param {number} timeout
 * @returns {Promise<Array<{ name: string, traceId: string, spanId: string, parentSpanId: string }>>}
 */
function waitForOtlpSpans (agent, count, timeout) {
  return new Promise((resolve, reject) => {
    const spans = []

    const onTraces = ({ payload }) => {
      for (const resourceSpan of payload.resourceSpans) {
        for (const scopeSpan of resourceSpan.scopeSpans) {
          spans.push(...scopeSpan.spans)
        }
      }

      if (spans.length >= count) {
        clearTimeout(timer)
        agent.off('otlp-traces', onTraces)
        resolve(spans)
      }
    }

    const timer = setTimeout(() => {
      agent.off('otlp-traces', onTraces)
      reject(new Error(`Timed out waiting for ${count} OTLP spans, received ${spans.length}`))
    }, timeout)

    agent.on('otlp-traces', onTraces)
  })
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

// The forked child boots a server on demand; OTEL/SDK init plus dd-trace startup take a
// non-deterministic amount of time. A fixed pre-request delay is either flaky (too short)
// or wasteful (too long); polling until the listener accepts is the cheapest robust way.
async function getWithRetry (url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastErr
  while (Date.now() < deadline) {
    try {
      return await axios.get(url)
    } catch (err) {
      lastErr = err
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw lastErr
}

describe('opentelemetry', function () {
  this.timeout(20_000)

  let agent = /** @type {FakeAgent | null} */ (null)
  let proc
  let cwd = /** @type {string} */ ('')
  const timeout = 5000
  const dependencies = [
    '@opentelemetry/api',
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
    proc = fork(join(cwd, 'opentelemetry/basic.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent?.port,
        DD_TRACE_OTEL_ENABLED: '1',
        DD_TELEMETRY_HEARTBEAT_INTERVAL: '1',
        TIMEOUT: '1500',
      },
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
    await getWithRetry(`http://localhost:${SERVER_PORT}/first-endpoint`, 10_000)

    await check(agent, proc, 10_000, ({ payload }) => {
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
    // The flag moves trace export onto OTLP, so these spans never reach the Datadog endpoint.
    const spansPromise = waitForOtlpSpans(agent, 9, 10_000)

    proc = fork(join(cwd, 'opentelemetry/auto-instrumentation.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent?.port,
        DD_TRACE_OTEL_ENABLED: '1',
        SERVER_PORT,
        DD_TRACE_DISABLED_INSTRUMENTATIONS: 'http,dns,express,net',
        DD_TRACE_OTEL_SEMANTICS_ENABLED: 'true',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${agent.port}/v1/traces`,
      },
    })
    // Attached before the request: the child can exit while `getWithRetry` is still resolving, and
    // `ChildProcess` does not replay an `exit` that already fired.
    const exitPromise = waitForExit(proc, 10_000)

    const requestPromise = getWithRetry(`http://localhost:${SERVER_PORT}/first-endpoint`, 10_000)
    const [spans] = await Promise.all([spansPromise, exitPromise, requestPromise])

    assert.strictEqual(spans.length, 9)

    // The OTLP span name carries what this test read from the Datadog `resource`.
    assert.ok(eachEqual(spans, [
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

    assert.ok(allEqual(spans, (span) => span.traceId))

    const [get3, query2, init2, handler2, get1, query1, init1, handler1, get2] = spans
    isChildOfOtlpSpan(query1, get1)
    isChildOfOtlpSpan(init1, get1)
    isChildOfOtlpSpan(handler1, get1)
    isChildOfOtlpSpan(get2, get1)
    isChildOfOtlpSpan(get3, get2)
    isChildOfOtlpSpan(query2, get3)
    isChildOfOtlpSpan(init2, get3)
    isChildOfOtlpSpan(handler2, get3)
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

  it('should deliver spans to a user span processor configured on @opentelemetry/sdk-node', async () => {
    // Regression guard: sdk-node 0.220+ passes span processors through the
    // provider constructor. The fixture exits non-zero if its own processor
    // never saw the span, so the tracer producing the DD span while dropping
    // the user's processor fails here rather than passing silently.
    proc = fork(join(cwd, 'opentelemetry/sdk-node-span-processor.js'), {
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

function isChildOfOtlpSpan (childSpan, parentSpan) {
  assert.strictEqual(childSpan.traceId, parentSpan.traceId)
  assert.notStrictEqual(childSpan.spanId, parentSpan.spanId)
  assert.strictEqual(childSpan.parentSpanId, parentSpan.spanId)
}

function sortMetricTags (metrics) {
  return metrics
    .map(metric => Array.isArray(metric) ? metric : metric.tags)
    .sort((a, b) => a.join(',').localeCompare(b.join(',')))
}
