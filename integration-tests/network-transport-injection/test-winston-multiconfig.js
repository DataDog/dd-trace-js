#!/usr/bin/env node

/**
 * Comprehensive test for Winston transport injection with different configurations
 * Tests all possible user transport scenarios to ensure compatibility
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
  service: 'winston-multiconfig-test',
  env: 'test',
  version: '1.0.0'
})

const winston = require('winston')
const fs = require('fs')
const path = require('path')

console.log('\n=== Winston Multi-Configuration Transport Injection Test ===\n')

// Clean up test files at start
const testLogFile1 = path.join(__dirname, 'winston-test-1.log')
const testLogFile2 = path.join(__dirname, 'winston-test-2.log')
try {
  if (fs.existsSync(testLogFile1)) fs.unlinkSync(testLogFile1)
  if (fs.existsSync(testLogFile2)) fs.unlinkSync(testLogFile2)
} catch (err) {
  // Ignore cleanup errors
}

// Test 1: Simple logger (no user transports)
console.log('Test 1: Simple logger (no user transports)')
const logger1 = winston.createLogger({
  level: 'info',
  format: winston.format.json()
})
console.log('Transports count:', logger1.transports.length)
console.log('Has HTTP transport:', logger1.transports.some(t => t.name === 'http') ? 'YES ✓' : 'NO ✗')

const span1 = tracer.startSpan('winston.multiconfig.test1')
tracer.scope().activate(span1, () => {
  logger1.info('Test 1: Simple logger with no user transports')
  span1.finish()
})

// Test 2: Logger with Console transport
console.log('\nTest 2: Logger with Console transport')
const logger2 = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console()
  ]
})
console.log('Transports count:', logger2.transports.length)
console.log('Has Console:', logger2.transports.some(t => t.name === 'console') ? 'YES ✓' : 'NO ✗')
console.log('Has HTTP transport:', logger2.transports.some(t => t.name === 'http') ? 'YES ✓' : 'NO ✗')

const span2 = tracer.startSpan('winston.multiconfig.test2')
tracer.scope().activate(span2, () => {
  logger2.info('Test 2: Logger with Console transport')
  span2.finish()
})

// Test 3: Logger with File transport
console.log('\nTest 3: Logger with File transport')
const logger3 = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: testLogFile1 })
  ]
})
console.log('Transports count:', logger3.transports.length)
console.log('Has File:', logger3.transports.some(t => t.name === 'file') ? 'YES ✓' : 'NO ✗')
console.log('Has HTTP transport:', logger3.transports.some(t => t.name === 'http') ? 'YES ✓' : 'NO ✗')

const span3 = tracer.startSpan('winston.multiconfig.test3')
tracer.scope().activate(span3, () => {
  logger3.info('Test 3: Logger with File transport')
  span3.finish()
})

// Test 4: Logger with multiple user transports (Console + File)
console.log('\nTest 4: Logger with multiple transports (Console + File)')
const logger4 = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: testLogFile2 })
  ]
})
console.log('Transports count:', logger4.transports.length)
console.log('Has Console:', logger4.transports.some(t => t.name === 'console') ? 'YES ✓' : 'NO ✗')
console.log('Has File:', logger4.transports.some(t => t.name === 'file') ? 'YES ✓' : 'NO ✗')
console.log('Has HTTP transport:', logger4.transports.some(t => t.name === 'http') ? 'YES ✓' : 'NO ✗')

const span4 = tracer.startSpan('winston.multiconfig.test4')
tracer.scope().activate(span4, () => {
  logger4.info('Test 4: Logger with Console + File transports')
  span4.finish()
})

// Test 5: Logger created with defaultMeta
console.log('\nTest 5: Logger with defaultMeta')
const logger5 = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  defaultMeta: { service: 'my-service', version: '2.0' },
  transports: [
    new winston.transports.Console()
  ]
})
console.log('Transports count:', logger5.transports.length)
console.log('Has HTTP transport:', logger5.transports.some(t => t.name === 'http') ? 'YES ✓' : 'NO ✗')

const span5 = tracer.startSpan('winston.multiconfig.test5')
tracer.scope().activate(span5, () => {
  logger5.info('Test 5: Logger with defaultMeta')
  span5.finish()
})

// Test 6: Logger with custom format
console.log('\nTest 6: Logger with custom format')
const logger6 = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console()
  ]
})
console.log('Transports count:', logger6.transports.length)
console.log('Has HTTP transport:', logger6.transports.some(t => t.name === 'http') ? 'YES ✓' : 'NO ✗')

const span6 = tracer.startSpan('winston.multiconfig.test6')
tracer.scope().activate(span6, () => {
  logger6.info('Test 6: Logger with custom format')
  span6.finish()
})

// Test 7: Child logger
console.log('\nTest 7: Child logger')
const parentLogger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console()
  ]
})
const childLogger = parentLogger.child({ requestId: '123' })
console.log('Parent transports count:', parentLogger.transports.length)
console.log('Child uses parent transports')
console.log('Has HTTP transport:', parentLogger.transports.some(t => t.name === 'http') ? 'YES ✓' : 'NO ✗')

const span7 = tracer.startSpan('winston.multiconfig.test7')
tracer.scope().activate(span7, () => {
  childLogger.info('Test 7: Child logger message')
  span7.finish()
})

// Test 8: Logger with transport added after creation
console.log('\nTest 8: Logger with transport added after creation')
const logger8 = winston.createLogger({
  level: 'info',
  format: winston.format.json()
})
console.log('Initial transports count:', logger8.transports.length)
logger8.add(new winston.transports.Console())
console.log('After adding Console:', logger8.transports.length)
console.log('Has HTTP transport:', logger8.transports.some(t => t.name === 'http') ? 'YES ✓' : 'NO ✗')

const span8 = tracer.startSpan('winston.multiconfig.test8')
tracer.scope().activate(span8, () => {
  logger8.info('Test 8: Logger with dynamically added transport')
  span8.finish()
})

console.log('\n=== Test Complete ===')
console.log('Check intake server to verify HTTP transport received logs from all 8 tests')
console.log('Expected: All tests should show HTTP transport injected')
console.log('Expected: Logs from tests with Console transport visible on stdout')
console.log('Expected: Logs from tests with File transport written to log files')

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
