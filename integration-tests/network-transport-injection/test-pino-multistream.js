#!/usr/bin/env node

/**
 * Test Pino transport injection with different configurations
 * Tests Approach 1: Post-Create Multistream
 */

// Configure log capture
process.env.DD_LOG_CAPTURE_ENABLED = 'true'
process.env.DD_LOG_CAPTURE_METHOD = 'transport'
process.env.DD_LOG_CAPTURE_HOST = 'localhost'
process.env.DD_LOG_CAPTURE_PORT = '8080'
process.env.DD_LOG_CAPTURE_FLUSH_INTERVAL_MS = '100'  // Fast flush for tests
process.env.DD_LOGS_INJECTION = 'true'

// Initialize tracer
const tracer = require('../../index').init({
  service: 'pino-multistream-test',
  env: 'test',
  version: '1.0.0'
})

const pino = require('pino')

console.log('\n=== Pino Multistream Transport Injection Test ===\n')

// Test 1: Simple logger (no user transport)
console.log('Test 1: Simple logger (no user transport)')
const logger1 = pino({ level: 'info' })
console.log('Transport injected:', logger1[Symbol.for('dd-trace-pino-transport-injected')] ? 'YES ✓' : 'NO ✗')

const span1 = tracer.startSpan('pino.multistream.test1')
tracer.scope().activate(span1, () => {
  logger1.info('Test 1: Simple logger message')
  span1.finish()
})

// Test 2: Logger with pino-pretty transport
console.log('\nTest 2: Logger with pino-pretty transport')
try {
  const logger2 = pino({
    level: 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname'
      }
    }
  })
  console.log('Transport injected:', logger2[Symbol.for('dd-trace-pino-transport-injected')] ? 'YES ✓' : 'NO ✗')

  const span2 = tracer.startSpan('pino.multistream.test2')
  tracer.scope().activate(span2, () => {
    logger2.info('Test 2: Logger with pino-pretty')
    span2.finish()
  })
} catch (err) {
  console.log('Failed to create pino-pretty logger:', err.message)
}

// Test 3: Logger with custom destination (stdout)
console.log('\nTest 3: Logger with custom destination')
const logger3 = pino({ level: 'info' }, process.stdout)
console.log('Transport injected:', logger3[Symbol.for('dd-trace-pino-transport-injected')] ? 'YES ✓' : 'NO ✗')

const span3 = tracer.startSpan('pino.multistream.test3')
tracer.scope().activate(span3, () => {
  logger3.info('Test 3: Logger with stdout destination')
  span3.finish()
})

// Test 4: Logger with multistream specified by user
console.log('\nTest 4: Logger with user-specified multistream')
try {
  const streams = pino.multistream([
    { stream: process.stdout }
  ])
  const logger4 = pino({ level: 'info' }, streams)
  console.log('Transport injected:', logger4[Symbol.for('dd-trace-pino-transport-injected')] ? 'YES ✓' : 'NO ✗')

  const span4 = tracer.startSpan('pino.multistream.test4')
  tracer.scope().activate(span4, () => {
    logger4.info('Test 4: Logger with user multistream')
    span4.finish()
  })
} catch (err) {
  console.log('Failed to create multistream logger:', err.message)
}

console.log('\n=== Test Complete ===')
console.log('Check intake server to verify HTTP transport received logs')
console.log('Expected: All 4 tests should show "Transport injected: YES ✓"')

setTimeout(() => {
  console.log('✅ Done\n')
  process.exit(0)
}, 200)
