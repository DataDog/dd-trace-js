'use strict'

// WARNING: the breakpoint targets below are referenced by line number from
// meta.json (BREAKPOINT_LINE). Update the BREAKPOINT_LINE values there if you
// move the `data.n = n` line or the unreachable `return n` line.

const guard = require('../startup-guard')

const OPERATIONS = Number(process.env.OPERATIONS)
const STARTUP_GUARD_MAX_SHARE = Number(process.env.STARTUP_GUARD_MAX_SHARE)
const TRACK_PROBE_OUTPUT = process.env.TRACK_PROBE_OUTPUT === 'true'
const CAPTURE_SNAPSHOT = process.env.CAPTURE_SNAPSHOT === 'true'
const OUTPUT_TIMEOUT = 15_000
const dataFixture = createData()

// The devtools worker and its ports are unref'd, so nothing holds the event
// loop open while the breakpoint installs or while the app awaits final output.
const keepAlive = setInterval(() => {}, 2 ** 31 - 1)
const debuggerBenchmark = require('./start-devtools-client')
const { probeCounts, stop } = debuggerBenchmark
debuggerBenchmark.start(() => {
  if (!TRACK_PROBE_OUTPUT) clearInterval(keepAlive)
  setImmediate(TRACK_PROBE_OUTPUT ? runCapturedLoop : runLoop)
})

/**
 * Run the passive-breakpoint control as a CPU loop.
 *
 * @returns {void}
 */
function runLoop () {
  guard.loopStart()
  for (let i = 0; i < OPERATIONS; i++) doSomeWork(i)
  finish()
}

/**
 * Run one continuous hot loop, then wait for every selected probe payload. The
 * final barrier makes completed work exact without adding work between hits.
 *
 * @returns {void}
 */
function runCapturedLoop () {
  guard.loopStart()
  for (let i = 0; i < OPERATIONS; i++) doSomeWork(i)

  if (!probeCounts) throw new Error('debugger completion counter was not initialized')
  const expectedProbes = OPERATIONS
  waitForProbeOutput(probeCounts, expectedProbes, () => {
    validateCapturedProbes(probeCounts, expectedProbes)
    stop()
    finish()
  })
}

/**
 * Wait without blocking the application thread until the debugger worker has
 * constructed the selected probe payload.
 *
 * @param {Int32Array} counter
 * @param {number} expected
 * @param {() => void} done
 * @returns {void}
 */
function waitForProbeOutput (counter, expected, done) {
  const actual = Atomics.load(counter, 0)
  if (actual === expected) return done()
  if (actual > expected) throw new Error(`debugger completed ${actual} of ${expected} expected probe payloads`)

  const waiter = Atomics.waitAsync(counter, 0, actual, OUTPUT_TIMEOUT)
  if (waiter.async) {
    waiter.value.then(result => finishProbeWait(counter, expected, done, result))
  } else {
    finishProbeWait(counter, expected, done, waiter.value)
  }
}

/**
 * Validate the worker completion count after an atomic wait.
 *
 * @param {Int32Array} counter
 * @param {number} expected
 * @param {() => void} done
 * @param {'ok' | 'not-equal' | 'timed-out'} result
 * @returns {void}
 */
function finishProbeWait (counter, expected, done, result) {
  const actual = Atomics.load(counter, 0)
  if (actual === expected) return done()
  if (result !== 'timed-out' && actual < expected) return waitForProbeOutput(counter, expected, done)

  throw new Error(`debugger completed ${actual} of ${expected} expected probe payloads`)
}

/**
 * Ensure snapshot probes never silently degrade to the no-snapshot path.
 *
 * @param {Int32Array} counts
 * @param {number} completed
 * @returns {void}
 */
function validateCapturedProbes (counts, completed) {
  const captured = Atomics.load(counts, 1)
  const expected = CAPTURE_SNAPSHOT ? completed : 0
  if (captured !== expected) {
    throw new Error(`debugger captured ${captured} of ${expected} expected snapshots`)
  }
}

/**
 * Report the measured loop and stop the benchmark after all worker output is complete.
 *
 * @returns {void}
 */
function finish () {
  clearInterval(keepAlive)
  guard.done(STARTUP_GUARD_MAX_SHARE)
}

/**
 * @param {number} n
 * @returns {number}
 */
function doSomeWork (n) {
  const data = dataFixture
  data.n = n // BREAKPOINT HERE!
  if (n < 0) {
    return n // BREAKPOINT HERE!
  }
  return data.n
}

/**
 * @returns {Record<string, unknown>}
 */
function createData () {
  const str = 'a'.repeat(1000)
  const arr = Array.from({ length: 100 }, (_, i) => i)

  const data = {
    n: 0,
    foo: 'bar',
    nil: null,
    undef: undefined,
    bool: true,
  }
  data.recursive = data

  for (let i = 0; i < 20; i++) {
    data[`str${i}`] = str
    data[`arr${i}`] = arr
  }

  return data
}
