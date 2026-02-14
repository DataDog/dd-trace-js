#!/usr/bin/env node

/**
 * Test script for Bunyan stream injection
 *
 * Usage:
 *   1. Start intake server: node test-intake-server.js
 *   2. Run this script: node test-bunyan-transport.js
 */

// Configure log capture via environment variables
process.env.DD_LOG_CAPTURE_ENABLED = 'true'
process.env.DD_LOG_CAPTURE_METHOD = 'transport'
process.env.DD_LOG_CAPTURE_HOST = 'localhost'
process.env.DD_LOG_CAPTURE_PORT = '8080'
process.env.DD_LOG_CAPTURE_FLUSH_INTERVAL_MS = '100'  // Fast flush for tests
process.env.DD_LOGS_INJECTION = 'true'

// Initialize tracer BEFORE requiring bunyan
const tracer = require('../../index').init({
  service: 'bunyan-test-app',
  env: 'test',
  version: '1.0.0'
})

// Create Bunyan logger
const bunyan = require('bunyan')
const logger = bunyan.createLogger({
  name: 'bunyan-test',
  level: 'trace',
  streams: [
    {
      level: 'info',
      stream: process.stdout
    }
  ]
})

console.log('\n=== Bunyan Stream Injection Test ===')
console.log('Logger created with synchronous stream injection')
console.log('Streams after injection:', logger.streams.length)
console.log('\nWriting test logs...\n')

// Create a traced operation
const span = tracer.startSpan('bunyan.test.operation')
tracer.scope().activate(span, () => {
  // Write logs within traced context - works immediately!
  logger.info('Bunyan test log 1 - info level')
  logger.warn({ userId: 12345 }, 'Bunyan test log 2 - warning level')
  logger.error({ error: 'test error' }, 'Bunyan test log 3 - error level')
  logger.info({
    action: 'user_login',
    ip: '192.168.1.1',
    userAgent: 'Mozilla/5.0'
  }, 'Bunyan test log 4 - with metadata')
  logger.trace('Bunyan test log 5 - trace level')

  span.finish()
})

console.log('\n✅ Test logs written')
console.log('Check intake server output for received logs with trace correlation')
console.log('Expected: All logs should include trace_id, span_id, service, env, version')

// Give time for async stream to flush (100ms interval + buffer)
setTimeout(() => {
  console.log('✅ Test complete\n')
  process.exit(0)
}, 200)
