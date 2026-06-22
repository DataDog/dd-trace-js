#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

/**
 * Integration test: buffered logs are flushed on process exit.
 *
 * Sets a very long flush interval (30s) so the periodic timer never fires
 * during the test. Verifies that logs are still delivered by the
 * beforeExitHandlers flush registered in log_plugin.js#configure().
 *
 * Usage:
 *   1. Start intake server: node integration-tests/log-capture-hooks/test-intake-server.js
 *   2. Run this script:     node integration-tests/log-capture-hooks/test-exit-flush.js
 *
 * Expected outcome:
 *   - Intake server receives 3 records (one per logger) despite:
 *     - flush interval being 30 000ms (never fires during ~1s test)
 *   - All three loggers are loaded before any logs are written so all 3 records
 *     accumulate in the sender buffer and are flushed together via beforeExitHandlers
 *   - Process exits naturally (no process.exit call) so that beforeExitHandlers fires
 *     NOTE: process.exit() bypasses the 'beforeExit' event, so it must NOT be used here
 */

process.env.DD_LOG_CAPTURE_ENABLED = 'true'
process.env.DD_LOG_CAPTURE_HOST = 'localhost'
process.env.DD_LOG_CAPTURE_PORT = '19876'
process.env.DD_LOG_CAPTURE_FLUSH_INTERVAL_MS = '30000' // 30s — will NOT fire during test
process.env.DD_LOGS_INJECTION = 'true'
process.env.DD_TRACE_STARTUP_LOGS = 'false' // suppress CONFIGURATION / INTEGRATIONS LOADED / Agent Error noise

// eslint-disable-next-line import/order
const tracer = require('../../index').init({
  service: 'exit-flush-test',
  env: 'test',
  version: '1.0.0',
})

// Load all loggers up-front so each plugin's sender.configure() call
// happens before any logs are written.  This ensures all 3 records land
// in the sender buffer together and are flushed as a single batch by
// beforeExitHandlers when the event loop drains.
const winston = require('winston')
const bunyan = require('bunyan')
const pino = require('pino')

const winstonLogger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [new winston.transports.Console({ silent: true })],
})
const bunyanLogger = bunyan.createLogger({
  name: 'exit-flush-test',
  level: 'info',
  streams: [{ stream: { write: () => {} } }],
})
const pinoLogger = pino({ level: 'info' }, { write: () => {} })

console.log('\n=== Exit Flush Test ===')
console.log('Flush interval: 30s (will NOT fire before process exits)')
console.log('Expected: intake receives all 3 logs via beforeExitHandlers on natural exit\n')

// --- Winston ---
const span1 = tracer.startSpan('exit.flush.winston')
tracer.scope().activate(span1, () => {
  winstonLogger.info('Winston: written before exit, flushed by beforeExitHandlers')
  span1.finish()
})
console.log('✅ Winston log written')

// --- Bunyan ---
const span2 = tracer.startSpan('exit.flush.bunyan')
tracer.scope().activate(span2, () => {
  bunyanLogger.info('Bunyan: written before exit, flushed by beforeExitHandlers')
  span2.finish()
})
console.log('✅ Bunyan log written')

// --- Pino ---
const span3 = tracer.startSpan('exit.flush.pino')
tracer.scope().activate(span3, () => {
  pinoLogger.info('Pino: written before exit, flushed by beforeExitHandlers')
  span3.finish()
})
console.log('✅ Pino log written')

console.log('\n3 records in buffer. Waiting for event loop to drain (beforeExitHandlers will flush)...\n')

// Hold the event loop open for 1s to show the 30s periodic timer never fires.
// After this timeout, the event loop drains naturally and beforeExit fires,
// triggering the sender flush.  Do NOT call process.exit() here — that would
// bypass the 'beforeExit' event and prevent the flush from running.
setTimeout(() => {
  console.log('1s elapsed — event loop draining, beforeExitHandlers should flush 3 records now...\n')
}, 1000)
