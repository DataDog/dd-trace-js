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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')

  if (url.pathname === '/state') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(state(), undefined, 2))
    return
  }

  if (url.pathname === '/work') {
    const result = burnCpu(Number(url.searchParams.get('ms')) || 25)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ result }))
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found', routes: ['/state', '/work'] }))
})

const port = Number(process.env.APP_PORT) || 8080
server.listen(port, () => {
  const actual = server.address().port
  log(`listening on http://127.0.0.1:${actual}  (/state, /work)`)
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
    http.get(`http://127.0.0.1:${server.address().port}/work?ms=25`, (res) => res.resume())
      .on('error', () => {})
  }, 500).unref()
}
