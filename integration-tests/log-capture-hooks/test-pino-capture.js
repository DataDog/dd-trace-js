#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

/**
 * Integration test: Pino log capture via wrapAsJson hook (all versions).
 *
 * Key feature: Unlike the mixin-only interception used for pino-pretty, this
 * test verifies that the COMPLETE log record is captured — including pid,
 * hostname, time, msg — for all Pino versions.
 *
 * Mechanism:
 *   For all pino versions, `wrapAsJson` wraps the internal `asJsonSym`
 *   serialiser and publishes the finished JSON line to `apm:pino:log:json`.
 *   PinoPlugin.handleJsonLine() handles both injection and capture from there.
 *
 * Usage:
 *   1. Start intake server: node integration-tests/log-capture-hooks/test-intake-server.js
 *   2. Run this script:     node integration-tests/log-capture-hooks/test-pino-capture.js
 *
 * Expected outcome:
 *   - 5 records received at intake
 *   - Each record contains: time (numeric ms), pid, hostname, level (numeric), msg
 *   - Each record contains dd.trace_id, dd.span_id, dd.service, dd.env, dd.version
 *   - Records are pre-serialized JSON (no additional stringify needed)
 */

process.env.DD_LOG_CAPTURE_ENABLED = 'true'
process.env.DD_LOG_CAPTURE_HOST = 'localhost'
process.env.DD_LOG_CAPTURE_PORT = '19876'
process.env.DD_LOG_CAPTURE_FLUSH_INTERVAL_MS = '100'
process.env.DD_LOGS_INJECTION = 'true'
process.env.DD_TRACE_STARTUP_LOGS = 'false'

// eslint-disable-next-line import/order
const tracer = require('../../index').init({
  service: 'pino-hook-test',
  env: 'test',
  version: '1.0.0',
})

const pino = require('pino')

const logger = pino(
  { level: 'trace' },
  { write: () => {} } // null sink — we only care about capture channel output
)

const pinoVersion = require('pino/package.json').version
console.log('\n=== Pino Hook Capture Test (pino v%s) ===', pinoVersion)
console.log('Capture path: wrapAsJson → apm:pino:log:json (complete record, all versions)')
console.log('Writing 5 log records...\n')

const span = tracer.startSpan('pino.hook.test')
tracer.scope().activate(span, () => {
  logger.info('Pino hook test 1 — info level')
  logger.warn({ userId: 42 }, 'Pino hook test 2 — warn level')
  logger.error({ err: new Error('test failure') }, 'Pino hook test 3 — error with err object')
  logger.debug('Pino hook test 4 — debug level')
  logger.info({
    action: 'checkout',
    orderId: 'ord-9876',
    amount: 49.99,
  }, 'Pino hook test 5 — with extra fields')
  span.finish()
})

console.log('✅ 5 records written')
console.log('Check intake server for 5 complete Pino records (time, pid, hostname, msg all present)\n')

setTimeout(() => {
  console.log('✅ Flush complete\n')
  process.exit(0)
}, 300)
