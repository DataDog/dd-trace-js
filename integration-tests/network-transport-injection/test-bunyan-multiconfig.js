#!/usr/bin/env node

/**
 * Comprehensive test for Bunyan stream injection with different configurations
 * Tests all possible user stream scenarios to ensure compatibility
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
  service: 'bunyan-multiconfig-test',
  env: 'test',
  version: '1.0.0'
})

const bunyan = require('bunyan')
const fs = require('fs')
const path = require('path')
const { Writable } = require('stream')

console.log('\n=== Bunyan Multi-Configuration Stream Injection Test ===\n')

// Clean up test files at start
const testLogFile1 = path.join(__dirname, 'bunyan-test-1.log')
const testLogFile2 = path.join(__dirname, 'bunyan-test-2.log')
try {
  if (fs.existsSync(testLogFile1)) fs.unlinkSync(testLogFile1)
  if (fs.existsSync(testLogFile2)) fs.unlinkSync(testLogFile2)
} catch (err) {
  // Ignore cleanup errors
}

// Test 1: Simple logger (no user streams)
console.log('Test 1: Simple logger (no user streams)')
const logger1 = bunyan.createLogger({
  name: 'test-1',
  level: 'trace'
})
console.log('Streams count:', logger1.streams.length)
console.log('Stream injection:', logger1.streams.length > 1 ? 'YES ✓' : 'NO ✗')

const span1 = tracer.startSpan('bunyan.multiconfig.test1')
tracer.scope().activate(span1, () => {
  logger1.info('Test 1: Simple logger with no user streams')
  span1.finish()
})

// Test 2: Logger with stdout stream
console.log('\nTest 2: Logger with stdout stream')
const logger2 = bunyan.createLogger({
  name: 'test-2',
  level: 'trace',
  streams: [
    {
      level: 'info',
      stream: process.stdout
    }
  ]
})
console.log('Streams count:', logger2.streams.length)
console.log('Stream injection:', logger2.streams.length > 1 ? 'YES ✓' : 'NO ✗')

const span2 = tracer.startSpan('bunyan.multiconfig.test2')
tracer.scope().activate(span2, () => {
  logger2.info('Test 2: Logger with stdout stream')
  span2.finish()
})

// Test 3: Logger with file stream
console.log('\nTest 3: Logger with file stream')
const logger3 = bunyan.createLogger({
  name: 'test-3',
  level: 'trace',
  streams: [
    {
      level: 'info',
      path: testLogFile1
    }
  ]
})
console.log('Streams count:', logger3.streams.length)
console.log('Stream injection:', logger3.streams.length > 1 ? 'YES ✓' : 'NO ✗')

const span3 = tracer.startSpan('bunyan.multiconfig.test3')
tracer.scope().activate(span3, () => {
  logger3.info('Test 3: Logger with file stream')
  span3.finish()
})

// Test 4: Logger with multiple streams (stdout + file)
console.log('\nTest 4: Logger with multiple streams (stdout + file)')
const logger4 = bunyan.createLogger({
  name: 'test-4',
  level: 'trace',
  streams: [
    {
      level: 'info',
      stream: process.stdout
    },
    {
      level: 'warn',
      path: testLogFile2
    }
  ]
})
console.log('Streams count:', logger4.streams.length)
console.log('Stream injection:', logger4.streams.length > 2 ? 'YES ✓' : 'NO ✗')

const span4 = tracer.startSpan('bunyan.multiconfig.test4')
tracer.scope().activate(span4, () => {
  logger4.info('Test 4: Logger with stdout + file streams')
  span4.finish()
})

// Test 5: Logger with raw stream (object mode)
console.log('\nTest 5: Logger with raw stream (object mode)')
const customRawStream = new Writable({
  objectMode: true,
  write(record, encoding, callback) {
    // Custom processing - just acknowledge
    callback()
  }
})

const logger5 = bunyan.createLogger({
  name: 'test-5',
  level: 'trace',
  streams: [
    {
      level: 'info',
      type: 'raw',
      stream: customRawStream
    }
  ]
})
console.log('Streams count:', logger5.streams.length)
console.log('Stream injection:', logger5.streams.length > 1 ? 'YES ✓' : 'NO ✗')

const span5 = tracer.startSpan('bunyan.multiconfig.test5')
tracer.scope().activate(span5, () => {
  logger5.info('Test 5: Logger with raw stream')
  span5.finish()
})

// Test 6: Logger with serializers
console.log('\nTest 6: Logger with serializers')
const logger6 = bunyan.createLogger({
  name: 'test-6',
  level: 'trace',
  streams: [
    {
      level: 'info',
      stream: process.stdout
    }
  ],
  serializers: {
    req: bunyan.stdSerializers.req,
    res: bunyan.stdSerializers.res,
    err: bunyan.stdSerializers.err
  }
})
console.log('Streams count:', logger6.streams.length)
console.log('Stream injection:', logger6.streams.length > 1 ? 'YES ✓' : 'NO ✗')

const span6 = tracer.startSpan('bunyan.multiconfig.test6')
tracer.scope().activate(span6, () => {
  logger6.info('Test 6: Logger with serializers')
  span6.finish()
})

// Test 7: Child logger
console.log('\nTest 7: Child logger')
const parentLogger = bunyan.createLogger({
  name: 'test-7-parent',
  level: 'trace',
  streams: [
    {
      level: 'info',
      stream: process.stdout
    }
  ]
})
const childLogger = parentLogger.child({ component: 'auth', requestId: '123' })
console.log('Parent streams count:', parentLogger.streams.length)
console.log('Child uses parent streams')
console.log('Stream injection:', parentLogger.streams.length > 1 ? 'YES ✓' : 'NO ✗')

const span7 = tracer.startSpan('bunyan.multiconfig.test7')
tracer.scope().activate(span7, () => {
  childLogger.info('Test 7: Child logger message')
  span7.finish()
})

// Test 8: Logger with stream added after creation
console.log('\nTest 8: Logger with stream added after creation')
const logger8 = bunyan.createLogger({
  name: 'test-8',
  level: 'trace',
  streams: [
    {
      level: 'info',
      stream: process.stdout
    }
  ]
})
console.log('Initial streams count:', logger8.streams.length)

// Add another stream dynamically
const additionalStream = new Writable({
  write(chunk, encoding, callback) {
    // Just acknowledge
    callback()
  }
})
logger8.addStream({
  level: 'debug',
  stream: additionalStream
})
console.log('After adding stream:', logger8.streams.length)
console.log('Stream injection present:', logger8.streams.length > 2 ? 'YES ✓' : 'NO ✗')

const span8 = tracer.startSpan('bunyan.multiconfig.test8')
tracer.scope().activate(span8, () => {
  logger8.info('Test 8: Logger with dynamically added stream')
  span8.finish()
})

// Test 9: Logger with stderr stream
console.log('\nTest 9: Logger with stderr stream')
const logger9 = bunyan.createLogger({
  name: 'test-9',
  level: 'trace',
  streams: [
    {
      level: 'error',
      stream: process.stderr
    }
  ]
})
console.log('Streams count:', logger9.streams.length)
console.log('Stream injection:', logger9.streams.length > 1 ? 'YES ✓' : 'NO ✗')

const span9 = tracer.startSpan('bunyan.multiconfig.test9')
tracer.scope().activate(span9, () => {
  logger9.error('Test 9: Logger with stderr stream')
  span9.finish()
})

// Test 10: Logger with level specified as string
console.log('\nTest 10: Logger with level as string')
const logger10 = bunyan.createLogger({
  name: 'test-10',
  level: 'info', // string instead of number
  stream: process.stdout
})
console.log('Streams count:', logger10.streams.length)
console.log('Stream injection:', logger10.streams.length > 1 ? 'YES ✓' : 'NO ✗')

const span10 = tracer.startSpan('bunyan.multiconfig.test10')
tracer.scope().activate(span10, () => {
  logger10.info('Test 10: Logger with string level')
  span10.finish()
})

console.log('\n=== Test Complete ===')
console.log('Check intake server to verify HTTP stream received logs from all 10 tests')
console.log('Expected: All tests should show stream injection')
console.log('Expected: Logs from tests with stdout/stderr visible on console')
console.log('Expected: Logs from tests with file streams written to log files')

setTimeout(() => {
  console.log('✅ Done\n')

  // Clean up test files
  try {
    if (fs.existsSync(testLogFile1)) fs.unlinkSync(testLogFile1)
    if (fs.existsSync(testLogFile2)) fs.unlinkSync(testLogFile2)
  } catch (err) {
    // Ignore cleanup errors
  }

  process.exit(0)
}, 200)
