#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

/**
 * Integration test: Winston log capture via hook forwarding.
 *
 * Demonstrates that Winston log records are forwarded to the intake via the
 * apm:winston:log diagnostic channel (no transport injection needed).
 *
 * Usage:
 *   1. Start intake server: node integration-tests/log-capture-hooks/test-intake-server.js
 *   2. Run this script:     node integration-tests/log-capture-hooks/test-winston-capture.js
 *
 * Expected outcome:
 *   - 5 records received at intake
 *   - Each record contains dd.trace_id, dd.span_id, dd.service, dd.env, dd.version
 *   - No Winston HTTP transport added to the logger (hook approach)
 */

process.env.DD_LOG_CAPTURE_ENABLED = 'true'
process.env.DD_LOG_CAPTURE_HOST = 'localhost'
process.env.DD_LOG_CAPTURE_PORT = '19876'
process.env.DD_LOG_CAPTURE_FLUSH_INTERVAL_MS = '100'
process.env.DD_LOGS_INJECTION = 'true'
process.env.DD_TRACE_STARTUP_LOGS = 'false'

const tracer = require('../../index').init({
  service: 'winston-hook-test',
  env: 'test',
  version: '1.0.0',
})

// eslint-disable-next-line import/order
const winston = require('winston')

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console({ silent: true }),
  ],
})

console.log('\n=== Winston Hook Capture Test ===')
console.log('Logger transports:', logger.transports.map(t => t.constructor.name))
console.log('Note: No HTTP transport injected — forwarding via apm:winston:log hook\n')
console.log('Writing 5 log records...\n')

const span = tracer.startSpan('winston.hook.test')
tracer.scope().activate(span, () => {
  logger.info('Winston hook test 1 — info level')
  logger.warn('Winston hook test 2 — warn level', { userId: 42 })
  logger.error('Winston hook test 3 — error level', { error: 'something broke' })
  logger.debug('Winston hook test 4 — debug level')
  logger.info('Winston hook test 5 — with extra fields', {
    action: 'checkout',
    orderId: 'ord-9876',
    amount: 49.99,
  })
  span.finish()
})

console.log('✅ 5 records written')
console.log('Check intake server for 5 records with dd.trace_id, dd.span_id, service, env, version\n')

setTimeout(() => {
  console.log('✅ Flush complete\n')
  process.exit(0)
}, 300)
