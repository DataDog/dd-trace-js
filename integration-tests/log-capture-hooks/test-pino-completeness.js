#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

/**
 * Integration test: Pino record completeness — apm:pino:log:json vs apm:pino:log.
 *
 * Demonstrates that `apm:pino:log:json` always provides a complete log record
 * (with time, pid, hostname, level, msg) for all Pino versions.
 *
 * Channel behaviour in the current architecture:
 *   - apm:pino:log     → only published by pino-pretty wrappers (wrapPrettifyObject /
 *                        wrapPrettyFactory). NOT published for regular pino usage.
 *   - apm:pino:log:json → published by wrapAsJson (wrapping asJsonSym) for all pino
 *                        versions. Always carries the fully-serialised JSON line.
 *
 * Usage:
 *   node integration-tests/log-capture-hooks/test-pino-completeness.js
 *
 * Expected output:
 *   apm:pino:log:       (no record — expected, not published for regular pino)
 *   apm:pino:log:json:  { time, pid, hostname, level, msg, dd } ← complete
 */

process.env.DD_LOG_CAPTURE_ENABLED = 'true'
process.env.DD_LOG_CAPTURE_HOST = 'localhost'
process.env.DD_LOG_CAPTURE_PORT = '19876'
process.env.DD_LOG_CAPTURE_FLUSH_INTERVAL_MS = '999999'
process.env.DD_LOGS_INJECTION = 'true'
process.env.DD_TRACE_STARTUP_LOGS = 'false'

// eslint-disable-next-line import/order
const tracer = require('../../index').init({
  service: 'pino-completeness-test',
  env: 'test',
  version: '1.0.0',
})

// eslint-disable-next-line n/no-restricted-require
const { channel } = require('diagnostics_channel')

// pino must be loaded before subscribing to apm:pino:log so that LogPlugin
// registers its subscriber first.  LogPlugin runs first in FIFO order and
// enriches arg.message with the dd proxy; our subscriber then sees that result.
const pino = require('pino')

// Capture what each channel sees directly (before HTTP batching)
let mixinRecord = null
let captureRecord = null

// apm:pino:log is only published by pino-pretty wrappers — not regular pino.
channel('apm:pino:log').subscribe(({ message }) => {
  mixinRecord = { ...message }
})

// apm:pino:log:json is published by wrapAsJson for all pino versions.
// The payload is { line: string } where line is the complete serialised JSON.
channel('apm:pino:log:json').subscribe(({ line }) => {
  captureRecord = JSON.parse(line)
})

const pinoVersion = require('pino/package.json').version

const logger = pino({ level: 'info' }, { write: () => {} })

console.log('\n=== Pino Record Completeness Test (pino v%s) ===\n', pinoVersion)

const span = tracer.startSpan('pino.completeness')
tracer.scope().activate(span, () => {
  logger.info({ requestId: 'req-123' }, 'completeness check message')
  span.finish()
})

setImmediate(() => {
  // Legend: ✅ present  -- intentionally absent  ❌ unexpectedly absent
  const present = (val) => val ? '✅ present' : '❌ MISSING (unexpected)'
  const expectedAbsent = (val) => val ? '✅ present' : '-- absent  (expected — not published for regular pino)'

  console.log('--- apm:pino:log (pino-pretty only — not published for regular pino) ---')
  if (mixinRecord) {
    const fields = Object.keys(mixinRecord)
    console.log('  Fields present: %s', fields.length ? fields.join(', ') : '(none)')
    console.log('  Note: this channel fired — are you using pino-pretty?')
  } else {
    console.log('  %s', expectedAbsent(false))
  }

  console.log('\n--- apm:pino:log:json (wrapAsJson — always complete) ---')
  if (captureRecord) {
    const fields = Object.keys(captureRecord)
    console.log('  Fields present: %s', fields.join(', '))
    console.log('  dd:       %s', present('dd' in captureRecord))
    console.log('  msg:      %s', present('msg' in captureRecord))
    console.log('  pid:      %s', present('pid' in captureRecord))
    console.log('  hostname: %s', present('hostname' in captureRecord))
    console.log('  time:     %s', present('time' in captureRecord))
    console.log('  msg value: %s', captureRecord.msg)
  } else {
    console.log('  (no record received — unexpected)')
  }

  console.log('\n--- Conclusion ---')
  if (captureRecord && captureRecord.msg && captureRecord.pid && captureRecord.hostname) {
    console.log('✅ CONFIRMED: apm:pino:log:json provides the complete record for all Pino versions.')
    if (!mixinRecord) {
      console.log('   apm:pino:log correctly not published for regular pino (pino-pretty only).')
    }
  } else {
    console.log('ℹ️  Unexpected state — check output above for details.')
  }

  console.log()
  process.exit(0)
})
