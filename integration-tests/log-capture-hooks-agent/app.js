'use strict'

// dd-trace MUST be required first — before express, pino, winston, bunyan, or any other module.
// In a test sandbox dd-trace is yarn-linked, so require('dd-trace') works.
// When running directly from the repo, fall back to the local package root.
let ddTrace
try {
  ddTrace = require('dd-trace')
} catch (_) {
  ddTrace = require('../..')
}
ddTrace.init()

const http = require('node:http')
const { Writable } = require('node:stream')
const express = require('express')
const bunyan = require('bunyan')
const pino = require('pino')
const winston = require('winston')

// Shared null sink — instrumentation hooks fire before the stream write, so no
// actual output is needed. All three loggers write to this sink to keep the
// demo app quiet while still exercising the dd-trace capture channel.
const nullStream = new Writable({ write (chunk, enc, cb) { cb() } })

const pinoLogger = pino({ level: 'trace' }, { write: () => {} })

const winstonLogger = winston.createLogger({
  level: 'silly',
  transports: [new winston.transports.Stream({ stream: nullStream })],
})

const bunyanLogger = bunyan.createLogger({ name: 'app', level: 'trace', stream: nullStream })

const app = express()

// ── Pino routes ────────────────────────────────────────────────────────────────
app.get('/info', (req, res) => {
  pinoLogger.info({ route: '/info' }, 'pino info route hit')
  res.sendStatus(200)
})

app.get('/warn', (req, res) => {
  pinoLogger.warn({ route: '/warn' }, 'pino warn route hit')
  res.sendStatus(200)
})

app.get('/error', (req, res) => {
  pinoLogger.error({ route: '/error' }, 'pino error route hit')
  res.sendStatus(200)
})

// ── Winston routes ─────────────────────────────────────────────────────────────
app.get('/winston/info', (req, res) => {
  winstonLogger.info('winston info route hit', { route: '/winston/info' })
  res.sendStatus(200)
})

app.get('/winston/warn', (req, res) => {
  winstonLogger.warn('winston warn route hit', { route: '/winston/warn' })
  res.sendStatus(200)
})

app.get('/winston/error', (req, res) => {
  winstonLogger.error('winston error route hit', { route: '/winston/error' })
  res.sendStatus(200)
})

// ── Bunyan routes ──────────────────────────────────────────────────────────────
app.get('/bunyan/info', (req, res) => {
  bunyanLogger.info({ route: '/bunyan/info' }, 'bunyan info route hit')
  res.sendStatus(200)
})

app.get('/bunyan/warn', (req, res) => {
  bunyanLogger.warn({ route: '/bunyan/warn' }, 'bunyan warn route hit')
  res.sendStatus(200)
})

app.get('/bunyan/error', (req, res) => {
  bunyanLogger.error({ route: '/bunyan/error' }, 'bunyan error route hit')
  res.sendStatus(200)
})

const server = http.createServer(app)
const listenPort = parseInt(process.env.APP_PORT || '0', 10)
server.listen(listenPort, () => {
  const { port } = server.address()
  if (process.send) process.send({ port })
  // eslint-disable-next-line no-console
  else console.log(`App listening on http://127.0.0.1:${port}`)
})
