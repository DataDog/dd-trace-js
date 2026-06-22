#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

/**
 * Integration test: log capture is suppressed when logCaptureEnabled=false.
 *
 * Runs an inline HTTP server to verify that zero records are forwarded when
 * DD_LOG_CAPTURE_ENABLED is unset (defaults to false). The test owns its server
 * and exits non-zero if the assertion fails — suitable for use in CI.
 *
 * Usage:
 *   node integration-tests/log-capture-hooks/test-disabled.js
 *   (No separate intake server required)
 *
 * Expected outcome:
 *   - EXIT 0: 0 records received — capture correctly suppressed
 *   - EXIT 1: any records received — capture incorrectly active
 */

// Intentionally NOT setting DD_LOG_CAPTURE_ENABLED — defaults to false.
// logInjection=true keeps the plugin active (for injection) so we exercise the
// path where the plugin runs but _captureEnabled is false.
process.env.DD_LOG_CAPTURE_FLUSH_INTERVAL_MS = '100'
process.env.DD_LOGS_INJECTION = 'true'
process.env.DD_TRACE_STARTUP_LOGS = 'false'

const http = require('node:http')

let received = 0

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return }
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    received += body.split('\n').filter(l => l.trim()).length
    res.writeHead(200)
    res.end('OK')
  })
})

server.listen(0, () => {
  // Set the capture port BEFORE loading the tracer so the config picks it up.
  process.env.DD_LOG_CAPTURE_HOST = 'localhost'
  process.env.DD_LOG_CAPTURE_PORT = String(server.address().port)

  const tracer = require('../../index').init({
    service: 'disabled-test',
    env: 'test',
    version: '1.0.0',
  })

  const winston = require('winston')
  const bunyan = require('bunyan')
  const pino = require('pino')

  const winstonLogger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [new winston.transports.Console({ silent: true })],
  })
  const bunyanLogger = bunyan.createLogger({
    name: 'disabled-test',
    streams: [{ stream: { write: () => {} } }],
  })
  const pinoLogger = pino({ level: 'info' }, { write: () => {} })

  console.log('\n=== Disabled Capture Test ===')
  console.log('DD_LOG_CAPTURE_ENABLED: unset (defaults false)')
  console.log('DD_LOGS_INJECTION: true (plugin active for injection, not capture)')
  console.log('Inline intake server on port %d\n', server.address().port)

  const span = tracer.startSpan('disabled.test')
  tracer.scope().activate(span, () => {
    winstonLogger.info('Should NOT be captured — Winston')
    bunyanLogger.info('Should NOT be captured — Bunyan')
    pinoLogger.info('Should NOT be captured — Pino')
    span.finish()
  })

  // Wait longer than flushIntervalMs so any accidental flush would arrive.
  setTimeout(() => {
    server.close()
    if (received === 0) {
      console.log('✅ PASS: 0 records received — capture correctly suppressed when disabled\n')
      process.exit(0)
    } else {
      console.error('❌ FAIL: %d record(s) received — capture fired despite being disabled\n', received)
      process.exit(1)
    }
  }, 400)
})
