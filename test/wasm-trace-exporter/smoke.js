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

const server = http.createServer((req, res) => {
  requestCount++
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    receivedPayload = Buffer.concat(chunks)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ rate_by_service: {} }))
  })
})

server.listen(0, '127.0.0.1', () => {
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

  const span = tracer.startSpan('smoke-test-operation')
  span.finish()

  const exporter = tracer._tracer?._exporter
  if (exporter && exporter.flush) {
    exporter.flush(() => {
      setTimeout(() => {
        server.close()

        if (requestCount === 0) {
          console.error('FAIL: Mock agent received no requests')
          process.exit(1)
        }

        if (!receivedPayload || receivedPayload.length === 0) {
          console.error('FAIL: Received empty payload')
          process.exit(1)
        }

        assert(receivedPayload.length > 0, 'Payload should be non-empty')
        console.log('PASS: wasm trace exporter smoke test - received %d bytes', receivedPayload.length)
      }, 300)
    })
  } else {
    console.error('FAIL: No exporter with flush found')
    server.close()
    process.exit(1)
  }
})
