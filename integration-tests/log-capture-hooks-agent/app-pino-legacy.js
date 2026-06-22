'use strict'

// app-pino-legacy.js — companion to app.js for testing pino versions < 5.14.0.
//
// In all pino versions, dd-trace wraps the internal `asJsonSym` serialiser via
// `wrapAsJson`, publishing each completed log line to the `apm:pino:log:json`
// diagnostic channel. This app exercises the older symbol path (`asJson` rather
// than the `asJsonSym` symbol) while sharing the same mock-intake.js as the
// main app.
//
// The required pino version is NOT declared in this file — Node.js has no
// in-file version constraint syntax. The version is enforced by:
//   • Automated tests  — useSandbox(['pino@>=5 <5.14.0']) in index-pino-legacy.spec.js
//   • Manual testing   — npm install pino@">=5 <5.14.0" inside this directory first
//
// A runtime guard below fails fast if the wrong version is loaded.
//
// dd-trace MUST be required first.
let ddTrace
try {
  ddTrace = require('dd-trace')
} catch (_) {
  ddTrace = require('../..')
}
ddTrace.init()

const http = require('node:http')
const express = require('express')
const pino = require('pino')

// ── Version guard ──────────────────────────────────────────────────────────────
// Fail fast if the wrong pino is loaded so the error is obvious rather than
// silently exercising the wrong instrumentation code path.
const pinoVersion = require('pino/package.json').version
const [major, minor] = pinoVersion.split('.').map(Number)
if (major > 5 || (major === 5 && minor >= 14)) {
  process.stderr.write(
    `app-pino-legacy.js requires pino < 5.14.0 but found ${pinoVersion}.\n` +
    'Run inside integration-tests/log-capture-hooks-agent/:\n' +
    '  npm install pino@">=5 <5.14.0"\n'
  )
  process.exit(1)
}

// null sink — the capture channel fires before the stream write, so no real
// output destination is needed.
const logger = pino({ level: 'trace' }, { write: () => {} })

const app = express()

app.get('/info', (req, res) => {
  logger.info({ route: '/info' }, 'pino info route hit')
  res.sendStatus(200)
})

app.get('/warn', (req, res) => {
  logger.warn({ route: '/warn' }, 'pino warn route hit')
  res.sendStatus(200)
})

app.get('/error', (req, res) => {
  logger.error({ route: '/error' }, 'pino error route hit')
  res.sendStatus(200)
})

const server = http.createServer(app)
const listenPort = parseInt(process.env.APP_PORT || '0', 10)
server.listen(listenPort, () => {
  const { port } = server.address()
  if (process.send) process.send({ port })
  else process.stdout.write(`App listening on http://127.0.0.1:${port}\n`)
})
