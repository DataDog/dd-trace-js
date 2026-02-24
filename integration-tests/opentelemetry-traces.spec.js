'use strict'

const assert = require('node:assert/strict')

const { fork } = require('child_process')
const { join } = require('path')
const { FakeAgent, sandboxCwd, useSandbox } = require('./helpers')

function waitForOtlpTraces (agent, timeout = 10000) {
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

    const { headers, payload } = await tracesPromise
    await exitPromise

    assert.strictEqual(headers['content-type'], 'application/json')

    // Validate ExportTraceServiceRequest top-level structure
    assert.ok(payload.resourceSpans, 'payload should have resourceSpans')
    assert.strictEqual(payload.resourceSpans.length, 1)

    const resourceSpan = payload.resourceSpans[0]

    // Validate resource attributes
    const resource = resourceSpan.resource
    assert.ok(resource, 'resourceSpan should have resource')
    assert.ok(Array.isArray(resource.attributes), 'resource should have attributes array')

    const resourceAttrs = Object.fromEntries(
      resource.attributes.map(({ key, value }) => [key, value])
    )
    assert.deepStrictEqual(resourceAttrs['service.name'], { stringValue: 'otlp-test-service' })
    assert.deepStrictEqual(resourceAttrs['deployment.environment.name'], { stringValue: 'test' })
    assert.deepStrictEqual(resourceAttrs['service.version'], { stringValue: '1.0.0' })

    // Validate scopeSpans
    assert.ok(Array.isArray(resourceSpan.scopeSpans), 'resourceSpan should have scopeSpans')
    assert.strictEqual(resourceSpan.scopeSpans.length, 1)

    const scopeSpan = resourceSpan.scopeSpans[0]
    assert.strictEqual(scopeSpan.scope.name, 'dd-trace-js')
    assert.ok(scopeSpan.scope.version, 'scope should have a version')

    // Validate spans
    const spans = scopeSpan.spans
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

    // Validate span names
    assert.strictEqual(webSpan.name, 'web.request')
    assert.strictEqual(dbSpan.name, 'db.query')
    assert.strictEqual(errSpan.name, 'error.operation')

    // Validate span kind (server=2, client=3 per OTLP proto SpanKind enum)
    assert.strictEqual(webSpan.kind, 2, 'web.request should be SERVER kind')
    assert.strictEqual(dbSpan.kind, 3, 'db.query should be CLIENT kind')

    // Validate timing fields
    for (const span of spans) {
      assert.ok(span.startTimeUnixNano > 0, 'span should have a positive startTimeUnixNano')
      assert.ok(span.endTimeUnixNano > 0, 'span should have a positive endTimeUnixNano')
      assert.ok(span.endTimeUnixNano >= span.startTimeUnixNano, 'endTime should be >= startTime')
    }

    // Validate error span status
    assert.strictEqual(errSpan.status.code, 2, 'error span should have STATUS_CODE_ERROR')
    assert.strictEqual(errSpan.status.message, 'test error message')

    // Validate non-error span status
    assert.strictEqual(webSpan.status.code, 0, 'non-error span should have STATUS_CODE_UNSET')

    // Validate span attributes include service.name and resource.name
    const webAttrs = Object.fromEntries(
      webSpan.attributes.map(({ key, value }) => [key, value])
    )
    assert.deepStrictEqual(webAttrs['service.name'], { stringValue: 'otlp-test-service' })
    assert.ok(webAttrs['resource.name'], 'span should have resource.name attribute')

    // Validate custom tags appear as attributes
    assert.deepStrictEqual(webAttrs['http.method'], { stringValue: 'GET' })
    assert.deepStrictEqual(webAttrs['http.url'], { stringValue: '/api/test' })

    const dbAttrs = Object.fromEntries(
      dbSpan.attributes.map(({ key, value }) => [key, value])
    )
    assert.deepStrictEqual(dbAttrs['db.type'], { stringValue: 'postgres' })
  })
})
