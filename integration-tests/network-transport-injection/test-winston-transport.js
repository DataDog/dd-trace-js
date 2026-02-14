#!/usr/bin/env node

/**
 * Test script for Winston transport injection
 *
 * Usage:
 *   1. Start intake server: node test-intake-server.js
 *   2. Run this script: node test-winston-transport.js
 */

// Configure log capture via environment variables
process.env.DD_LOG_CAPTURE_ENABLED = 'true'
process.env.DD_LOG_CAPTURE_METHOD = 'transport'
process.env.DD_LOG_CAPTURE_HOST = 'localhost'
process.env.DD_LOG_CAPTURE_PORT = '8080'
process.env.DD_LOG_CAPTURE_FLUSH_INTERVAL_MS = '100'  // Fast flush for tests
process.env.DD_LOGS_INJECTION = 'true'

// Initialize tracer BEFORE requiring winston
const tracer = require('../../index').init({
  service: 'winston-test-app',
  env: 'test',
  version: '1.0.0'
})

// Create Winston logger
const winston = require('winston')
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
})

console.log('\n=== Winston Transport Injection Test ===')
console.log('Logger created. Check if HTTP transport was injected.')
console.log('Transports:', logger.transports.map(t => t.constructor.name))
console.log('\nWriting test logs...\n')

// Create a traced operation
const span = tracer.startSpan('winston.test.operation')
tracer.scope().activate(span, () => {
  // Write logs within traced context
  logger.info('Winston test log 1 - info level')
  logger.warn('Winston test log 2 - warning level', { userId: 12345 })
  logger.error('Winston test log 3 - error level', { error: 'test error' })
  logger.info('Winston test log 4 - with metadata', {
    action: 'user_login',
    ip: '192.168.1.1',
    userAgent: 'Mozilla/5.0'
  })
  logger.debug('Winston test log 5 - debug level (may not show)')

  span.finish()
})

console.log('\n✅ Test logs written')
console.log('Check intake server output for received logs with trace correlation')
console.log('Expected: All logs should include trace_id, span_id, service, env, version')

// Give time for async transport to flush (100ms interval + buffer)
setTimeout(() => {
  console.log('✅ Test complete\n')
  process.exit(0)
}, 200)
