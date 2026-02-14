#!/usr/bin/env node

/**
 * Benchmark to measure performance overhead of transport injection
 * Compares logging performance with and without transport injection
 */

const { performance } = require('perf_hooks')

// Test configurations
const NUM_LOGS = 10000
const WARMUP_LOGS = 1000

console.log('\n=== Transport Injection Performance Benchmark ===\n')
console.log(`Iterations: ${NUM_LOGS.toLocaleString()}`)
console.log(`Warmup: ${WARMUP_LOGS.toLocaleString()}\n`)

// Helper to measure performance
function benchmark(name, fn) {
  // Warmup
  for (let i = 0; i < WARMUP_LOGS; i++) {
    fn()
  }

  // Force GC if available
  if (global.gc) global.gc()

  // Actual benchmark
  const start = performance.now()
  for (let i = 0; i < NUM_LOGS; i++) {
    fn()
  }
  const end = performance.now()

  const totalMs = end - start
  const perLogUs = (totalMs * 1000) / NUM_LOGS

  console.log(`${name}:`)
  console.log(`  Total: ${totalMs.toFixed(2)}ms`)
  console.log(`  Per-log: ${perLogUs.toFixed(3)}μs`)
  console.log(`  Rate: ${(NUM_LOGS / (totalMs / 1000)).toFixed(0)} logs/sec`)
  console.log('')

  return { totalMs, perLogUs }
}

// ==================== WINSTON ====================
console.log('--- Winston ---\n')

// Without transport injection
const winston1 = require('winston')
const winstonLoggerBaseline = winston1.createLogger({
  level: 'info',
  format: winston1.format.json(),
  transports: [new winston1.transports.Console({ silent: true })]
})

const winstonBaseline = benchmark('Winston (baseline)', () => {
  winstonLoggerBaseline.info('test message', { userId: 12345, action: 'test' })
})

// With transport injection
process.env.DD_LOG_CAPTURE_ENABLED = 'true'
process.env.DD_LOG_CAPTURE_METHOD = 'transport'
process.env.DD_LOG_CAPTURE_HOST = 'localhost'
process.env.DD_LOG_CAPTURE_PORT = '9999'  // Non-existent server (buffering only)
process.env.DD_LOG_CAPTURE_FLUSH_INTERVAL_MS = '999999'  // Very long (no flushing during test)
process.env.DD_LOGS_INJECTION = 'true'

require('../../index').init({
  service: 'benchmark-test',
  env: 'test',
  version: '1.0.0'
})

const winston2 = require('winston')
const winstonLoggerWithTransport = winston2.createLogger({
  level: 'info',
  format: winston2.format.json(),
  transports: [new winston2.transports.Console({ silent: true })]
})

const winstonWithTransport = benchmark('Winston (with transport)', () => {
  winstonLoggerWithTransport.info('test message', { userId: 12345, action: 'test' })
})

const winstonOverheadUs = winstonWithTransport.perLogUs - winstonBaseline.perLogUs
const winstonOverheadPct = ((winstonOverheadUs / winstonBaseline.perLogUs) * 100).toFixed(1)
console.log(`Winston Overhead: ${winstonOverheadUs.toFixed(3)}μs (${winstonOverheadPct}%)\n`)

// ==================== BUNYAN ====================
console.log('--- Bunyan ---\n')

// Without transport injection
delete require.cache[require.resolve('bunyan')]
const bunyan1 = require('bunyan')
const bunyanLoggerBaseline = bunyan1.createLogger({
  name: 'benchmark-baseline',
  level: 'info',
  streams: [{ stream: { write: () => {} } }]  // Null stream
})

const bunyanBaseline = benchmark('Bunyan (baseline)', () => {
  bunyanLoggerBaseline.info({ userId: 12345, action: 'test' }, 'test message')
})

// With transport injection (already initialized tracer above)
delete require.cache[require.resolve('bunyan')]
const bunyan2 = require('bunyan')
const bunyanLoggerWithTransport = bunyan2.createLogger({
  name: 'benchmark-with-transport',
  level: 'info',
  streams: [{ stream: { write: () => {} } }]  // Null stream
})

const bunyanWithTransport = benchmark('Bunyan (with transport)', () => {
  bunyanLoggerWithTransport.info({ userId: 12345, action: 'test' }, 'test message')
})

const bunyanOverheadUs = bunyanWithTransport.perLogUs - bunyanBaseline.perLogUs
const bunyanOverheadPct = ((bunyanOverheadUs / bunyanBaseline.perLogUs) * 100).toFixed(1)
console.log(`Bunyan Overhead: ${bunyanOverheadUs.toFixed(3)}μs (${bunyanOverheadPct}%)\n`)

// ==================== PINO ====================
console.log('--- Pino ---\n')

// Without transport injection
const pino1 = require('pino')
const pinoLoggerBaseline = pino1({ level: 'info' }, { write: () => {} })  // Null destination

const pinoBaseline = benchmark('Pino (baseline)', () => {
  pinoLoggerBaseline.info({ userId: 12345, action: 'test' }, 'test message')
})

// With transport injection (already initialized tracer above)
delete require.cache[require.resolve('pino')]
const pino2 = require('pino')
const pinoLoggerWithTransport = pino2({ level: 'info' }, { write: () => {} })

const pinoWithTransport = benchmark('Pino (with transport)', () => {
  pinoLoggerWithTransport.info({ userId: 12345, action: 'test' }, 'test message')
})

const pinoOverheadUs = pinoWithTransport.perLogUs - pinoBaseline.perLogUs
const pinoOverheadPct = ((pinoOverheadUs / pinoBaseline.perLogUs) * 100).toFixed(1)
console.log(`Pino Overhead: ${pinoOverheadUs.toFixed(3)}μs (${pinoOverheadPct}%)\n`)

// ==================== SUMMARY ====================
console.log('=== Summary ===\n')
console.log('Per-Log Overhead:')
console.log(`  Winston: ${winstonOverheadUs.toFixed(3)}μs (${winstonOverheadPct}% increase)`)
console.log(`  Bunyan:  ${bunyanOverheadUs.toFixed(3)}μs (${bunyanOverheadPct}% increase)`)
console.log(`  Pino:    ${pinoOverheadUs.toFixed(3)}μs (${pinoOverheadPct}% increase)`)
console.log('')

// Memory info
const memUsage = process.memoryUsage()
console.log('Memory Usage:')
console.log(`  Heap Used: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`)
console.log(`  External: ${(memUsage.external / 1024 / 1024).toFixed(2)} MB`)
console.log('')

console.log('Note: Run with --expose-gc for accurate memory measurements')
console.log('Example: node --expose-gc benchmark-overhead.js\n')

process.exit(0)
