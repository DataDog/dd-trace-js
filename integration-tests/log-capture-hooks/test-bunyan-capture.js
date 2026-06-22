#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

/**
 * Integration test: Bunyan log capture via hook forwarding.
 *
 * Demonstrates that Bunyan log records (complete: pid, hostname, time, msg)
 * are forwarded to the intake via the apm:bunyan:log diagnostic channel.
 *
 * Usage:
 *   1. Start intake server: node integration-tests/log-capture-hooks/test-intake-server.js
 *   2. Run this script:     node integration-tests/log-capture-hooks/test-bunyan-capture.js
 *
 * Expected outcome:
 *   - 5 records received at intake
 *   - Each record contains: pid, hostname, time, msg, v, name, level
 *   - Each record contains dd.trace_id, dd.span_id, dd.service, dd.env, dd.version
 */

process.env.DD_LOG_CAPTURE_ENABLED = 'true'
process.env.DD_LOG_CAPTURE_HOST = 'localhost'
process.env.DD_LOG_CAPTURE_PORT = '19876'
process.env.DD_LOG_CAPTURE_FLUSH_INTERVAL_MS = '100'
process.env.DD_LOGS_INJECTION = 'true'
process.env.DD_TRACE_STARTUP_LOGS = 'false'

const tracer = require('../../index').init({
  service: 'bunyan-hook-test',
  env: 'test',
  version: '1.0.0',
})

// eslint-disable-next-line import/order
const bunyan = require('bunyan')

const logger = bunyan.createLogger({
  name: 'bunyan-hook-test',
  level: 'trace',
  streams: [{ level: 'trace', stream: { write: () => {} } }], // null sink — level: trace to capture all test records
})

console.log('\n=== Bunyan Hook Capture Test ===')
console.log('Note: No stream injection — forwarding via apm:bunyan:log hook\n')
console.log('Writing 5 log records...\n')

const span = tracer.startSpan('bunyan.hook.test')
tracer.scope().activate(span, () => {
  logger.info('Bunyan hook test 1 — info level')
  logger.warn({ userId: 42 }, 'Bunyan hook test 2 — warn level')
  logger.error({ err: new Error('test failure') }, 'Bunyan hook test 3 — error with err object')
  logger.debug('Bunyan hook test 4 — debug level')
  logger.info({
    action: 'checkout',
    orderId: 'ord-9876',
    amount: 49.99,
  }, 'Bunyan hook test 5 — with extra fields')
  span.finish()
})

console.log('✅ 5 records written')
console.log('Check intake server for 5 complete Bunyan records (pid, hostname, time present)\n')

setTimeout(() => {
  console.log('✅ Flush complete\n')
  process.exit(0)
}, 300)
