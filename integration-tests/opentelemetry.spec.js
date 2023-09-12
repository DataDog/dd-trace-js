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
      '@opentelemetry/api'
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

      const spanCreated = metrics.series.find(({ metric }) => metric === 'span_created')
      const spanFinished = metrics.series.find(({ metric }) => metric === 'span_finished')

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
