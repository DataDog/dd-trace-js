'use strict'

// Standalone debug and load driver for the native-spans PoC. Single process: the
// shared test app, a fake-agent sink and the load generator all live here, and the
// span implementation is chosen by `DD_TRACE_EXPERIMENTAL_NATIVE_SPANS`.
//
//   DD_TRACE_EXPERIMENTAL_NATIVE_SPANS=1 node native-spans-debug.js
//   DD_TRACE_EXPERIMENTAL_NATIVE_SPANS=1 node native-spans-debug.js --load --duration-ms 10000
//
// Default mode prints each decoded trace as it lands, for curl-and-eyeball debugging.
// `--load` turns that off, runs the generator, and prints req/s plus p50/p95/p99.
//
// Deliberately not a sirun benchmark: no repetitions, no warmup, no JSON report, no
// third-party workload. That ceremony belongs to `benchmark/sirun/native-spans`. The
// load-generator math — closed-loop concurrency, histogram percentiles — is reused
// from `native-spans-bench.js` rather than re-derived.

const http = require('node:http')
const { performance } = require('node:perf_hooks')

const HISTOGRAM_RESOLUTION = 100
const HISTOGRAM_MAX_MS = 600

const options = parseArguments(process.argv.slice(2))

if (options.help) {
  printHelp()
  process.exit(0)
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})

async function main () {
  const { startCaptureServer } = require('./benchmark/sirun/native-spans/capture-server')

  const sink = await startCaptureServer({
    decode: !options.load,
    onChunk: options.load ? undefined : printChunk,
  })

  process.env.DD_TRACE_AGENT_URL = `http://127.0.0.1:${sink.port}`
  process.env.DD_TRACE_ENABLED = 'true'

  const tracer = require('./').init()
  const { ROUTES, startApp } = require('./benchmark/sirun/native-spans/app')
  const app = await startApp({ tracer, port: options.port })

  const implementation = process.env.DD_TRACE_EXPERIMENTAL_NATIVE_SPANS === '1' ? 'native' : 'baseline'
  process.stdout.write(`native-spans-debug: ${implementation} spans, app on ` +
    `http://127.0.0.1:${app.port}, sink on http://127.0.0.1:${sink.port}\n`)

  if (!options.load) {
    process.stdout.write(`routes: ${ROUTES.join(' ')}\n`)
    return
  }

  const result = await runLoad(app.port, ROUTES, options)
  process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`)

  await app.close()
  // Let the last flush and its off-thread PUT land before the sink goes away.
  await new Promise(resolve => setTimeout(resolve, 1500))
  await sink.close()
}

/**
 * Closed-loop load: `concurrency` requests in flight at all times for `durationMs`,
 * each completion immediately starting the next.
 *
 * @param {number} port
 * @param {string[]} routes
 * @param {{ durationMs: number, concurrency: number }} settings
 * @returns {Promise<object>}
 */
function runLoad (port, routes, { durationMs, concurrency }) {
  return new Promise(resolve => {
    const histogram = new Uint32Array(HISTOGRAM_MAX_MS * HISTOGRAM_RESOLUTION + 1)
    const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency })
    const startedAt = performance.now()

    let completed = 0
    let failed = 0
    let inFlight = 0
    let issued = 0
    let stopping = false
    let stoppedAt
    let lastFailureReason

    const finish = () => {
      if (!stopping || inFlight !== 0) return
      agent.destroy()
      const elapsedSeconds = (stoppedAt - startedAt) / 1000
      resolve({
        implementation: process.env.DD_TRACE_EXPERIMENTAL_NATIVE_SPANS === '1' ? 'native' : 'baseline',
        requestsPerSecond: Math.round(completed / elapsedSeconds),
        medianMs: percentile(histogram, completed, 0.5),
        p95Ms: percentile(histogram, completed, 0.95),
        p99Ms: percentile(histogram, completed, 0.99),
        completed,
        failed,
        lastFailureReason,
        elapsedSeconds,
      })
    }

    const request = () => {
      if (stopping) return
      const path = routes[issued++ % routes.length]
      const requestStartedAt = performance.now()
      inFlight++

      const outgoing = http.get({ host: '127.0.0.1', port, path, agent }, response => {
        response.resume()
        response.once('end', () => {
          inFlight--
          if (!stopping) {
            // `/error` answers 500 by design, so any answer counts as served.
            completed++
            record(histogram, performance.now() - requestStartedAt)
            request()
          }
          finish()
        })
      })

      outgoing.setTimeout(5000, () => outgoing.destroy(new Error('request timed out')))
      outgoing.once('error', error => {
        inFlight--
        if (!stopping) {
          failed++
          lastFailureReason = error.message
          request()
        }
        finish()
      })
    }

    for (let index = 0; index < concurrency; index++) request()

    setTimeout(() => {
      stopping = true
      stoppedAt = performance.now()
      finish()
    }, durationMs)
  })
}

function record (histogram, durationMs) {
  const bucket = Math.min(histogram.length - 1, Math.round(durationMs * HISTOGRAM_RESOLUTION))
  histogram[bucket]++
}

function percentile (histogram, count, quantile) {
  if (count === 0) return 0
  const target = Math.ceil(count * quantile)
  let seen = 0
  for (let bucket = 0; bucket < histogram.length; bucket++) {
    seen += histogram[bucket]
    if (seen >= target) return bucket / HISTOGRAM_RESOLUTION
  }
  return HISTOGRAM_MAX_MS
}

/**
 * @param {import('./benchmark/sirun/native-spans/capture-server').CapturedSpan[]} chunk
 */
function printChunk (chunk) {
  process.stdout.write(`\nchunk (${chunk.length} span(s)) trace ${chunk[0].trace_id}\n`)
  for (const span of chunk) {
    process.stdout.write(`  ${span.name} ${JSON.stringify({
      resource: span.resource,
      service: span.service,
      type: span.type,
      span_id: span.span_id,
      parent_id: span.parent_id,
      error: span.error,
      duration: span.duration,
      meta: span.meta,
      metrics: span.metrics,
    })}\n`)
  }
}

function parseArguments (argv) {
  const parsed = {
    load: false,
    help: false,
    durationMs: 10_000,
    concurrency: 25,
    port: 0,
  }

  for (let index = 0; index < argv.length; index++) {
    switch (argv[index]) {
      case '--load':
        parsed.load = true
        break
      case '--duration-ms':
        parsed.durationMs = positiveInteger(argv[++index], 'duration-ms')
        break
      case '--concurrency':
        parsed.concurrency = positiveInteger(argv[++index], 'concurrency')
        break
      case '--port':
        parsed.port = positiveInteger(argv[++index], 'port')
        break
      case '--help':
      case '-h':
        parsed.help = true
        break
      default:
        throw new Error(`unknown argument ${argv[index]}`)
    }
  }

  return parsed
}

function positiveInteger (value, name) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`)
  }
  return parsed
}

function printHelp () {
  process.stdout.write(`Usage: node native-spans-debug.js [options]

Pick the implementation with DD_TRACE_EXPERIMENTAL_NATIVE_SPANS=1 (or 0).

  --load                 Run the load generator instead of printing traces
  --duration-ms <n>      Load duration (default: 10000)
  --concurrency <n>      Closed-loop HTTP concurrency (default: 25)
  --port <n>             App port (default: ephemeral)
  -h, --help             Show this help
`)
}
