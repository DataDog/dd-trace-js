'use strict'

// Smallest practical app for the SDK Configuration / dynamic-profiling remote-config demo.
//
// Loads the combined local dd-trace-js build (this worktree, two levels up), stays alive so the
// remote-config client keeps polling, produces continuous CPU work so the profiler has something
// to sample, and exposes the tracer's live configuration state over HTTP.
//
// Start with:  node demo/sdk-config-rc/app.js

/* eslint-disable import/order -- dd-trace must be required and initialized before any module it
   instruments, otherwise this file captures an unpatched `http` and generates no spans. That
   ordering is the opposite of what import/order wants. */
/* eslint-disable no-console -- this is a demo CLI; its log output is the deliverable. */

const tracer = require('../..')

tracer.init({
  // Short flush interval so traces show up promptly during a live demo.
  flushInterval: 1000,
})

const http = require('node:http')
const { performance } = require('node:perf_hooks')

// dc-polyfill resolves to the same channel registry the tracer uses, so this observes the real
// 'datadog:config:update' publishes rather than a copy.
const { channel } = require('dc-polyfill')
const profilerModule = require('../../packages/dd-trace/src/profiler')

const config = tracer._tracer._config

const PROFILING_KEY = 'profiling.DD_PROFILING_ENABLED'

/** Every config:update publish seen, newest last. Surfaced on /state as evidence. */
const configUpdates = []
let lastProfilingValue = config.profiling.DD_PROFILING_ENABLED
let lastProfilerStarted = profilerModule.started
let faulted = false
let inFlight = 0
const requestStarts = []
const recentRequests = []

function stamp () {
  return new Date().toISOString()
}

function log (...args) {
  console.log(`[${stamp()}]`, ...args)
}

channel('datadog:config:update').subscribe((updated) => {
  const value = updated.profiling.DD_PROFILING_ENABLED
  const origin = updated.getOrigin(PROFILING_KEY)

  const entry = {
    at: stamp(),
    'profiling.DD_PROFILING_ENABLED': value,
    origin,
    profilerStarted: profilerModule.started,
  }
  configUpdates.push(entry)

  log(`config:update  DD_PROFILING_ENABLED=${value}  origin=${origin}`)

  if (value !== lastProfilingValue) {
    log(`>>> CONFIG CHANGED  DD_PROFILING_ENABLED: ${lastProfilingValue} -> ${value} (origin=${origin})`)
    lastProfilingValue = value
  }
})

// profiler.js starts the profiler from its own subscriber to the same channel. Subscriber order is
// not guaranteed, and a start can be deferred, so poll for the transition instead of reading it
// inline above.
setInterval(() => {
  const started = profilerModule.started
  if (started !== lastProfilerStarted) {
    log(`>>> PROFILER ${started ? 'STARTED' : 'STOPPED'} (was ${lastProfilerStarted})`)
    lastProfilerStarted = started
  }
}, 200).unref()

function state () {
  return {
    service: config.service,
    env: config.env,
    version: config.version,
    runtimeId: config.tags?.['runtime-id'],
    tracerVersion: require('../../package.json').version,
    remoteConfigEnabled: config.remoteConfig.DD_REMOTE_CONFIGURATION_ENABLED,
    remoteConfigPollIntervalSeconds: config.remoteConfig.pollInterval,
    profiling: {
      DD_PROFILING_ENABLED: config.profiling.DD_PROFILING_ENABLED,
      origin: config.getOrigin(PROFILING_KEY),
      profilerStarted: profilerModule.started,
    },
    configUpdateCount: configUpdates.length,
    configUpdates,
  }
}

// Bounded CPU work, so /work produces a real trace and the wall/CPU profilers have samples.
function burnCpu (ms) {
  const until = Date.now() + ms
  let acc = 0
  while (Date.now() < until) {
    for (let i = 0; i < 1e5; i++) acc += Math.sqrt(i) * Math.sin(i)
  }
  return acc
}

class PaymentAuthorizationError extends Error {
  constructor (message) {
    super(message)
    this.name = 'PaymentAuthorizationError'
  }
}

function spanIdentity (span) {
  const context = span?.context()
  return {
    traceId: context?.toTraceId(),
    spanId: context?.toSpanId(),
  }
}

function observedSpan (request, name, resource, operation) {
  const parentId = spanIdentity(tracer.scope().active()).spanId
  const startedAt = performance.now()
  const offsetMs = startedAt - request.startedMonotonic
  let failure

  return tracer.trace(name, { resource }, (span) => {
    try {
      return operation()
    } catch (error) {
      failure = error
      span.setTag('error', error)
      throw error
    } finally {
      request.spans.push({
        ...spanIdentity(span),
        parentId,
        name,
        resource,
        offsetMs,
        durationMs: performance.now() - startedAt,
        error: Boolean(failure),
      })
    }
  })
}

function verifyProviderSignature (request) {
  return observedSpan(request, 'payment.verify_signature', 'verifyProviderSignature', () => {
    burnCpu(faulted ? 180 : 8)
    if (faulted) throw new Error('malformed payment-provider signature')
    return true
  })
}

function authorizePayment (request) {
  return observedSpan(request, 'checkout.authorize', 'authorizePayment', () => {
    const attempts = faulted ? 3 : 1
    let lastError
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return observedSpan(request, 'payment.retry', `retryPayment attempt ${attempt}`, () => {
          return verifyProviderSignature(request)
        })
      } catch (error) {
        lastError = error
      }
    }
    const error = new PaymentAuthorizationError(
      `payment-provider response failed validation after ${attempts} attempts`
    )
    error.cause = lastError
    throw error
  })
}

function recordRequest (request, statusCode, error) {
  const root = tracer.scope().active()
  const identity = spanIdentity(root)
  recentRequests.push({
    id: `${request.startedAt}-${identity.spanId || recentRequests.length}`,
    ...identity,
    resource: 'POST /checkout/payment',
    method: 'POST',
    startedAt: request.startedAt,
    durationMs: performance.now() - request.startedMonotonic,
    statusCode,
    error: error ? { name: error.name, message: error.message } : undefined,
    spans: request.spans,
  })
  if (recentRequests.length > 80) recentRequests.splice(0, recentRequests.length - 80)
}

function percentile (values, fraction) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

function telemetryState () {
  const now = Date.now()
  const windowMs = 10_000
  const completed = recentRequests.filter((request) => now - Date.parse(request.startedAt) <= windowMs)
  const arrivals = requestStarts.filter((startedAt) => now - startedAt <= windowMs)
  return {
    service: config.service,
    env: config.env,
    faulted,
    profiling: state().profiling,
    ready: completed.length > 0,
    sample: {
      ServiceID: config.service,
      ErrorRate: completed.length
        ? completed.filter((request) => request.statusCode >= 500).length / completed.length
        : 0,
      LatencyP95: percentile(completed.map((request) => request.durationMs), 0.95),
      Throughput: completed.length / (windowMs / 1000),
      ArrivalRate: arrivals.length / (windowMs / 1000),
      InFlight: inFlight,
      At: new Date().toISOString(),
    },
    recentRequests: recentRequests.slice(-20).reverse(),
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')

  if (url.pathname === '/state') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(state(), undefined, 2))
    return
  }

  if (url.pathname === '/telemetry') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(telemetryState(), undefined, 2))
    return
  }

  if (url.pathname === '/fault' && req.method === 'POST') {
    faulted = url.searchParams.get('enabled') === 'true'
    log(`demo fault ${faulted ? 'ENABLED' : 'CLEARED'} for POST /checkout/payment`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ faulted }))
    return
  }

  if (url.pathname === '/checkout/payment') {
    const request = {
      startedAt: new Date().toISOString(),
      startedMonotonic: performance.now(),
      spans: [],
    }
    requestStarts.push(Date.now())
    if (requestStarts.length > 200) requestStarts.splice(0, requestStarts.length - 200)
    inFlight++

    let statusCode = 200
    let error
    try {
      authorizePayment(request)
    } catch (caught) {
      statusCode = 500
      error = caught
      tracer.scope().active()?.setTag('error', caught)
    } finally {
      inFlight--
      recordRequest(request, statusCode, error)
    }

    res.writeHead(statusCode, { 'content-type': 'application/json' })
    res.end(JSON.stringify(error ? { error: error.name, message: error.message } : { authorized: true }))
    return
  }

  if (url.pathname === '/work') {
    const result = burnCpu(Number(url.searchParams.get('ms')) || 25)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ result }))
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    error: 'not found',
    routes: ['/state', '/telemetry', '/fault', '/checkout/payment', '/work'],
  }))
})

const port = Number(process.env.APP_PORT) || 8080
server.listen(port, () => {
  const actual = server.address().port
  log(`listening on http://127.0.0.1:${actual}  (/state, /telemetry, /checkout/payment, /work)`)
  log(`service=${config.service} env=${config.env} version=${config.version}`)
  log(`remote config enabled=${config.remoteConfig.DD_REMOTE_CONFIGURATION_ENABLED} ` +
      `poll=${config.remoteConfig.pollInterval}s`)
  log(`DD_PROFILING_ENABLED=${config.profiling.DD_PROFILING_ENABLED} ` +
      `origin=${config.getOrigin(PROFILING_KEY)} profilerStarted=${profilerModule.started}`)
  process.send?.({ port: actual })
})

// Self-driven request loop, so the app generates traces and CPU load with no external driver.
if (process.env.DEMO_NO_LOAD !== '1') {
  setInterval(() => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: '/checkout/payment',
      method: 'POST',
    }, (res) => res.resume())
    request.on('error', () => {})
    request.end()
  }, 500).unref()
}
