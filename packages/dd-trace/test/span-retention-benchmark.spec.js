'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const { describe, it } = require('mocha')

const root = path.resolve(__dirname, '../../..')
const benchmarkDirectory = path.join(root, 'benchmark/sirun/span-retention')
const benchmark = path.join(benchmarkDirectory, 'index.js')
const failOnForcedGc = path.join(__dirname, 'fixtures/fail-on-forced-gc.js')

/**
 * @param {'async-resource' | 'long-timer' | 'request-only'} retainer
 * @param {string | undefined} maxHeapGrowth
 * @param {boolean} failOnGc
 * @param {boolean} [printResults]
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runBenchmark (retainer, maxHeapGrowth, failOnGc, printResults) {
  const preload = failOnGc ? ['--require', failOnForcedGc] : []
  return spawnSync(process.execPath, [
    '--expose-gc',
    ...preload,
    benchmark,
  ], {
    cwd: benchmarkDirectory,
    encoding: 'utf8',
    env: {
      ...process.env,
      BATCHES: '5',
      DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
      DD_TRACE_STARTUP_LOGS: 'false',
      ...(maxHeapGrowth === undefined ? {} : { MAX_HEAP_GROWTH_BYTES_PER_REQUEST: maxHeapGrowth }),
      MIDDLEWARE_COUNT: '5',
      OPERATIONS: '2500',
      ...(printResults ? { PRINT_RESULTS: '1' } : {}),
      REQUESTS_PER_BATCH: '500',
      RETAINER: retainer,
      STARTUP_GUARD_REPORT: '/dev/null',
      WARMUP_REQUESTS: '10',
    },
    timeout: 30_000,
  })
}

describe('span-retention benchmark', () => {
  it('does not force garbage collection in the request-only control', () => {
    const result = runBenchmark('request-only', '2048', true)
    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('enforces the heap growth threshold for retained resources', () => {
    const result = runBenchmark('async-resource', '1', false)
    assert.notStrictEqual(result.status, 0)
    assert.match(result.stderr, /heap growth was .* expected at most 1/)
  })

  it('reports bounded timer retention with the default threshold', () => {
    const result = runBenchmark('long-timer', undefined, false, true)
    assert.strictEqual(result.status, 0, result.stderr)

    const output = JSON.parse(result.stdout)
    assert.strictEqual(output.retainer, 'long-timer')
    assert.ok(output.bytesPerRequest <= 2048)
  })
})
