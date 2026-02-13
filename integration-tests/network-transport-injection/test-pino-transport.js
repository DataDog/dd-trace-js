#!/usr/bin/env node

/**
 * Test script for Pino transport injection
 *
 * Usage:
 *   1. Start intake server: node test-intake-server.js
 *   2. Run this script: node test-pino-transport.js
 */

// Configure log capture via environment variables
process.env.DD_LOG_CAPTURE_ENABLED = 'true'
process.env.DD_LOG_CAPTURE_METHOD = 'transport'
process.env.DD_LOG_CAPTURE_HOST = 'localhost'
process.env.DD_LOG_CAPTURE_PORT = '8080'
process.env.DD_LOG_CAPTURE_FLUSH_INTERVAL_MS = '100'  // Fast flush for tests
process.env.DD_LOGS_INJECTION = 'true'

// Initialize tracer BEFORE requiring pino
const tracer = require('../../index').init({
  service: 'pino-test-app',
  env: 'test',
  version: '1.0.0'
})

// Create Pino logger with pino-pretty
// Our HTTP transport will be automatically combined via multistream
const pino = require('pino')
const logger = pino({
  level: 'trace',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  }
})

console.log('\n=== Pino Transport Injection Test ===')
console.log('Logger created. Check if HTTP transport was injected.')

// Check if our transport injection symbol is present
const hasInjectedTransport = logger[Symbol.for('dd-trace-pino-transport-injected')]
console.log('Transport injected:', hasInjectedTransport ? 'YES ✓' : 'NO ✗')
console.log('\nWriting test logs...\n')

// Create a traced operation
const span = tracer.startSpan('pino.test.operation')
tracer.scope().activate(span, () => {
  // Write logs within traced context
  logger.info('Pino test log 1 - info level')
  logger.warn({ userId: 12345 }, 'Pino test log 2 - warning level')
  logger.error({ error: 'test error' }, 'Pino test log 3 - error level')
  logger.info({
    action: 'user_login',
    ip: '192.168.1.1',
    userAgent: 'Mozilla/5.0'
  }, 'Pino test log 4 - with metadata')
  logger.trace('Pino test log 5 - trace level')

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
