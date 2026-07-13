'use strict'

/* eslint-disable no-console */

const assert = require('node:assert/strict')
const { AsyncResource } = require('node:async_hooks')
const { once } = require('node:events')
const path = require('node:path')
const { promisify } = require('node:util')

const EXPRESS_PATH = require.resolve('express')
const HTTP_MODULE = 'node:http'

const guard = require('../startup-guard')

process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = 'false'
process.env.DD_TRACE_STARTUP_LOGS = 'false'

const tracerRoot = process.env.DD_TRACE_ROOT || path.resolve(__dirname, '../../..')
const tracer = require(tracerRoot).init()
tracer.use('http', { client: false })

const express = require(EXPRESS_PATH)
const http = require(HTTP_MODULE)

const BATCHES = Number(process.env.BATCHES)
const MIDDLEWARE_COUNT = Number(process.env.MIDDLEWARE_COUNT)
const REQUESTS_PER_BATCH = Number(process.env.REQUESTS_PER_BATCH)
const RETAINER = process.env.RETAINER
const WARMUP_REQUESTS = Number(process.env.WARMUP_REQUESTS)
const BASELINE_OR_CANDIDATE = process.env.BASELINE_OR_CANDIDATE
const MAX_HEAP_GROWTH_BYTES_PER_REQUEST = Number(
  process.env.MAX_HEAP_GROWTH_BYTES_PER_REQUEST ?? 2048
)
const LONG_TIMER_DELAY = 2 ** 31 - 1
const MIDDLEWARE_SPAN_NAMES = new Set(['express.middleware', 'router.middleware'])
const RETAINERS = []
const RETAINER_NAMES = new Set(['async-resource', 'long-timer', 'request-only'])
const setImmediateAsync = promisify(setImmediate)

assert.equal(typeof global.gc, 'function', 'span-retention benchmark requires --expose-gc')
assert.ok(BATCHES > 1, 'BATCHES must be greater than one')
assert.ok(MIDDLEWARE_COUNT > 0, 'MIDDLEWARE_COUNT must be positive')
assert.ok(REQUESTS_PER_BATCH > 0, 'REQUESTS_PER_BATCH must be positive')
assert.ok(RETAINER_NAMES.has(RETAINER), `unknown RETAINER: ${RETAINER}`)
assert.ok(WARMUP_REQUESTS > 0, 'WARMUP_REQUESTS must be positive')
assert.ok(MAX_HEAP_GROWTH_BYTES_PER_REQUEST > 0, 'MAX_HEAP_GROWTH_BYTES_PER_REQUEST must be positive')

let exportedMiddlewareSpans = 0
const exportedSpanNames = new Set()
const exporter = {
  /**
   * @param {Array<{ name: string }>} spans
   */
  export (spans) {
    for (const span of spans) {
      exportedSpanNames.add(span.name)
      if (MIDDLEWARE_SPAN_NAMES.has(span.name)) exportedMiddlewareSpans++
    }
  },
}
tracer._tracer._processor._exporter = exporter

const app = express()

/**
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 * @param {import('express').NextFunction} next
 */
function passThroughMiddleware (request, response, next) {
  next()
}

for (let i = 0; i < MIDDLEWARE_COUNT; i++) {
  app.use(passThroughMiddleware)
}

/**
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 */
function handleRequest (request, response) {
  if (RETAINER === 'async-resource') {
    RETAINERS.push(new AsyncResource('span-retention-benchmark', { requireManualDestroy: true }))
  } else if (RETAINER === 'long-timer') {
    RETAINERS.push(setTimeout(() => {}, LONG_TIMER_DELAY))
  }
  response.status(200).send('ok')
}

app.get('/', handleRequest)

const server = http.createServer(app)
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })

async function request () {
  const clientRequest = http.get({
    agent,
    host: '127.0.0.1',
    path: '/',
    port: server.address().port,
  })
  const [response] = await once(clientRequest, 'response')
  response.resume()
  await once(response, 'end')
  assert.equal(response.statusCode, 200, 'server did not return HTTP 200')
}

/**
 * @param {number} count
 */
async function sendRequests (count) {
  for (let i = 0; i < count; i++) {
    await request()
  }
}

function releaseRetainers () {
  if (RETAINER === 'async-resource') {
    for (const resource of RETAINERS) {
      resource.emitDestroy()
    }
  } else if (RETAINER === 'long-timer') {
    for (const timer of RETAINERS) {
      clearTimeout(timer)
    }
  }
  RETAINERS.length = 0
}

async function measureHeapUsed () {
  global.gc()
  await setImmediateAsync()
  global.gc()
  return process.memoryUsage().heapUsed
}

/**
 * @param {number[]} samples
 */
function calculateBytesPerRequest (samples) {
  const sampleCount = samples.length
  const meanBatch = (sampleCount - 1) / 2
  let covariance = 0
  let variance = 0

  for (let i = 0; i < sampleCount; i++) {
    const batchDistance = i - meanBatch
    covariance += batchDistance * samples[i]
    variance += batchDistance ** 2
  }

  return covariance / variance / REQUESTS_PER_BATCH
}

/**
 * @param {unknown} error
 */
function onError (error) {
  releaseRetainers()
  agent.destroy()
  server.close()
  console.error(error)
  process.exitCode = 1
}

async function main () {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  await sendRequests(WARMUP_REQUESTS)
  assert.ok(
    exportedMiddlewareSpans >= WARMUP_REQUESTS * MIDDLEWARE_COUNT,
    `warmup did not export the expected middleware spans: ${[...exportedSpanNames].join(', ')}`
  )
  assert.equal(
    RETAINERS.length,
    RETAINER === 'request-only' ? 0 : WARMUP_REQUESTS,
    'warmup did not create the expected retainers'
  )

  releaseRetainers()
  const heapSamples = [await measureHeapUsed()]

  guard.loopStart()
  for (let i = 0; i < BATCHES; i++) {
    await sendRequests(REQUESTS_PER_BATCH)
    heapSamples.push(await measureHeapUsed())
  }
  // Keep revision comparisons below Node's default heap limit even when the measured tracer leaks.
  guard.done(0.15)

  const bytesPerRequest = calculateBytesPerRequest(heapSamples)
  // The pre-fix baseline intentionally exceeds this guard; it must still run so
  // Sirun can compare its built-in metrics with the candidate.
  if (BASELINE_OR_CANDIDATE !== 'baseline') {
    assert.ok(
      bytesPerRequest <= MAX_HEAP_GROWTH_BYTES_PER_REQUEST,
      `heap growth was ${bytesPerRequest.toFixed(1)} bytes/request, ` +
      `expected at most ${MAX_HEAP_GROWTH_BYTES_PER_REQUEST}`
    )
  }

  if (process.env.PRINT_RESULTS === '1') {
    console.log(JSON.stringify({
      bytesPerRequest,
      heapSamples,
      requests: BATCHES * REQUESTS_PER_BATCH,
      retainer: RETAINER,
    }))
  }

  releaseRetainers()
  agent.destroy()
  server.close()
  await once(server, 'close')
}

main().catch(onError)
