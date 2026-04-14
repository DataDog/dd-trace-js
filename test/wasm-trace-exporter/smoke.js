#!/usr/bin/env node
'use strict'

/**
 * Smoke test: dd-trace with wasm exporter sends traces to a mock agent.
 *
 * Prerequisites:
 *   1. Build libdatadog-nodejs wasm: cd ../libdatadog-nodejs && yarn build-wasm (or just trace_exporter)
 *   2. libdatadog-nodejs must be a sibling of dd-trace-js in the workspace
 *
 * Run:
 *   DD_TRACE_EXPERIMENTAL_EXPORTER=wasm node test/wasm-trace-exporter/smoke.js
 */

const http = require('http')
const assert = require('assert')

// Set env before dd-trace is loaded
process.env.DD_TRACE_EXPERIMENTAL_EXPORTER = 'wasm'
process.env.DD_TRACE_ENABLED = 'true'
process.env.DD_TRACING_ENABLED = 'true'
process.env.DD_TRACE_STARTUP_LOGS = 'false'
process.env.DD_APPSEC_ENABLED = 'false'
process.env.DD_IAST_ENABLED = 'false'
process.env.DD_REMOTE_CONFIGURATION_ENABLED = 'false'
process.env.DD_LLMOBS_ENABLED = 'false'

let receivedPayload = null
let requestCount = 0
let failNextN = 0

const server = http.createServer((req, res) => {
  requestCount++
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    receivedPayload = Buffer.concat(chunks)
    if (failNextN > 0) {
      failNextN--
      res.writeHead(503)
      res.end()
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ rate_by_service: {} }))
    }
  })
})

function flushAndWait (exporter, waitMs = 500) {
  return new Promise(resolve => {
    exporter.flush(() => setTimeout(resolve, waitMs))
  })
}

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  process.env.DD_AGENT_HOST = '127.0.0.1'
  process.env.DD_TRACE_AGENT_PORT = String(port)

  const tracer = require('../../packages/dd-trace')

  try {
    tracer.init()
  } catch (e) {
    console.error('init failed:', e)
    server.close()
    process.exit(1)
  }

  const exporter = tracer._tracer?._exporter
  if (!exporter || !exporter.flush) {
    console.error('FAIL: No exporter with flush found')
    server.close()
    process.exit(1)
  }

  try {
    // --- Phase 1: happy path ---
    const span = tracer.startSpan('smoke-test-operation')
    span.finish()

    await flushAndWait(exporter)

    assert(requestCount > 0, 'Mock agent should have received at least one request')
    assert(receivedPayload && receivedPayload.length > 0, 'Payload should be non-empty')
    console.log('PASS: happy path - received %d bytes', receivedPayload.length)

    // --- Phase 2: retry on 503 ---
    // The wasm trace exporter now retries with exponential backoff via
    // SleepCapability (previously retries were disabled on wasm).
    const beforeRetry = requestCount
    failNextN = 1

    const retrySpan = tracer.startSpan('smoke-test-retry')
    retrySpan.finish()

    await flushAndWait(exporter, 2000)

    assert(
      requestCount >= beforeRetry + 2,
      `expected at least 2 requests (1 fail + 1 success), got ${requestCount - beforeRetry}`
    )
    console.log('PASS: retry on 503 - agent received trace after retry')

    console.log('\nAll smoke tests passed.')
  } catch (err) {
    console.error('Test error:', err)
    process.exitCode = 1
  } finally {
    server.close()
  }
})
