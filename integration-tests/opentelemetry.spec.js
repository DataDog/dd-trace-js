'use strict'

const { FakeAgent, createSandbox } = require('./helpers')
const { fork } = require('child_process')
const { join } = require('path')
const { assert } = require('chai')

function check (agent, proc, timeout, onMessage = () => { }) {
  return Promise.all([
    agent.assertMessageReceived(onMessage, timeout),
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

describe('opentelemetry', () => {
  let agent
  let proc
  let sandbox
  let cwd
  const timeout = 5000

  before(async () => {
    sandbox = await createSandbox([
      '@opentelemetry/api',
      '@opentelemetry/sdk-node',
      // Needed because sdk-node doesn't start a tracer without an exporter
      '@opentelemetry/exporter-jaeger'
    ])
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
})
