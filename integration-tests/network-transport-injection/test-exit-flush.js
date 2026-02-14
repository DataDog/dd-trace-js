#!/usr/bin/env node

/**
 * Test exit handler - verify logs are flushed on process exit
 * Simulates a Lambda function that exits immediately after logging
 */

// Configure log capture with fast flush for testing
process.env.DD_LOG_CAPTURE_ENABLED = 'true'
process.env.DD_LOG_CAPTURE_METHOD = 'transport'
process.env.DD_LOG_CAPTURE_HOST = 'localhost'
process.env.DD_LOG_CAPTURE_PORT = '8080'
process.env.DD_LOG_CAPTURE_FLUSH_INTERVAL_MS = '5000'  // 5 seconds - longer than test runtime
process.env.DD_LOGS_INJECTION = 'true'

// Initialize tracer
const tracer = require('../../index').init({
  service: 'exit-flush-test',
  env: 'test',
  version: '1.0.0'
})

console.log('\n=== Exit Handler Flush Test ===')
console.log('This test verifies logs are flushed even if flush interval has not elapsed')
console.log('Flush interval: 5 seconds')
console.log('Test runtime: ~1 second')
console.log('')

// Test Bunyan
console.log('Test 1: Bunyan exit flush')
const bunyan = require('bunyan')
const bunyanLogger = bunyan.createLogger({
  name: 'exit-test-bunyan',
  level: 'trace'
})

const span1 = tracer.startSpan('bunyan.exit.test')
tracer.scope().activate(span1, () => {
  bunyanLogger.info('Bunyan log written just before exit')
  span1.finish()
})

// Test Pino
console.log('Test 2: Pino exit flush')
const pino = require('pino')
const pinoLogger = pino({ level: 'trace' })

const span2 = tracer.startSpan('pino.exit.test')
tracer.scope().activate(span2, () => {
  pinoLogger.info('Pino log written just before exit')
  span2.finish()
})

// Test Winston
console.log('Test 3: Winston exit flush')
const winston = require('winston')
const winstonLogger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [new winston.transports.Console()]
})

const span3 = tracer.startSpan('winston.exit.test')
tracer.scope().activate(span3, () => {
  winstonLogger.info('Winston log written just before exit')
  span3.finish()
})

console.log('')
console.log('✅ All logs written')
console.log('⏰ Exiting in 1 second (before 5-second flush interval)')
console.log('📡 Check intake server - logs should still be received via exit handlers')
console.log('')

// Exit after 1 second (before the 5-second flush interval would trigger)
setTimeout(() => {
  console.log('🚪 Exiting now (exit handlers should flush logs)...\n')
  process.exit(0)
}, 1000)
