'use strict'

const assert = require('node:assert/strict')

const { fork } = require('child_process')
const { join } = require('path')
const { assertObjectContains, FakeAgent, sandboxCwd, useSandbox } = require('./helpers')

/**
 * @param {FakeAgent} agent
 * @param {number} timeout
 * @returns {Promise<{ headers: Record<string, string>, payload: object }>}
 */
function waitForOtlpTraces (agent, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for OTLP traces')), timeout)
    agent.once('otlp-traces', (msg) => {
      clearTimeout(timer)
      resolve(msg)
    })
  })
}

describe('OTLP Trace Export', () => {
  let agent
  let cwd
  const timeout = 10000

  useSandbox()

  before(async () => {
    cwd = sandboxCwd()
    agent = await new FakeAgent().start()
  })

  after(async () => {
    await agent.stop()
  })

  it('should export traces in OTLP JSON format', async () => {
    const tracesPromise = waitForOtlpTraces(agent, timeout)
    const beforeNs = Date.now() * 1e6

    const proc = fork(join(cwd, 'opentelemetry/otlp-traces.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port,
        OTEL_TRACES_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${agent.port}/v1/traces`,
        DD_SERVICE: 'otlp-test-service',
        DD_ENV: 'test',
        DD_VERSION: '1.0.0',
      },
    })

    const exitPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Process timed out')), timeout)
      proc.on('error', reject)
      proc.on('exit', (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          reject(new Error(`Process exited with status code ${code}`))
        } else {
          resolve()
        }
      })
    })

    const [{ headers, payload }] = await Promise.all([tracesPromise, exitPromise])

    assert.strictEqual(headers['content-type'], 'application/json')

    assertObjectContains(payload, {
      resourceSpans: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'otlp-test-service' } },
            { key: 'deployment.environment.name', value: { stringValue: 'test' } },
            { key: 'service.version', value: { stringValue: '1.0.0' } },
          ],
        },
        scopeSpans: [{
          scope: { name: 'dd-trace-js' },
        }],
      }],
    })

    const resourceSpan = payload.resourceSpans[0]
    assert.ok(resourceSpan.scopeSpans[0].scope.version, 'scope should have a version')

    const spans = resourceSpan.scopeSpans[0].spans
    assert.strictEqual(spans.length, 3, 'should have 3 spans')

    // Sort by name for stable ordering
    spans.sort((a, b) => a.name.localeCompare(b.name))
    const [dbSpan, errSpan, webSpan] = spans

    // All spans should share the same traceId
    assert.deepStrictEqual(dbSpan.traceId, webSpan.traceId, 'all spans should share a traceId')
    assert.deepStrictEqual(errSpan.traceId, webSpan.traceId, 'all spans should share a traceId')

    // Root span (web.request) should not have parentSpanId
    assert.strictEqual(webSpan.parentSpanId, undefined, 'root span should not have parentSpanId')

    // Child spans should have parentSpanId equal to root span's spanId
    assert.deepStrictEqual(dbSpan.parentSpanId, webSpan.spanId, 'child span should reference parent')
    assert.deepStrictEqual(errSpan.parentSpanId, webSpan.spanId, 'error span should reference parent')

    assertObjectContains(webSpan, {
      name: 'GET /api/test',
      kind: 2, // SERVER
      status: { code: 0 },
    })
    assertObjectContains(dbSpan, {
      name: 'db.query',
      kind: 3, // CLIENT
    })
    assertObjectContains(errSpan, {
      name: 'error.operation',
      status: { code: 2, message: 'test error message' },
    })

    // Validate timing fields
    for (const span of spans) {
      assert.ok(span.startTimeUnixNano >= beforeNs, 'span startTimeUnixNano should be >= test start time')
      assert.ok(span.endTimeUnixNano > 0, 'span should have a positive endTimeUnixNano')
      assert.ok(span.endTimeUnixNano >= span.startTimeUnixNano, 'endTime should be >= startTime')
    }

    assertObjectContains(webSpan.attributes, [
      { key: 'service.name', value: { stringValue: 'otlp-test-service' } },
      { key: 'operation.name', value: { stringValue: 'web.request' } },
      { key: 'resource.name', value: { stringValue: 'GET /api/test' } },
      { key: 'http.method', value: { stringValue: 'GET' } },
      { key: 'http.url', value: { stringValue: '/api/test' } },
    ])
    assertObjectContains(dbSpan.attributes, [
      { key: 'db.type', value: { stringValue: 'postgres' } },
    ])
  })
})
