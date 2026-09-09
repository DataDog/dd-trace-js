'use strict'

// WARNING: the breakpoint targets below are referenced by line number from
// meta.json (BREAKPOINT_LINE). Update the BREAKPOINT_LINE values there if you
// move the `data.n = n` line or the unreachable `return n` line.

const guard = require('../startup-guard')
const {
  CAPTURE_KIND_INDEX,
  CAPTURE_KIND_NAMES,
  CAPTURE_KINDS,
  COMPLETED_PROBE_INDEX,
  HANDLED_PROBE_INDEX,
  MATCHED_CAPTURE_KIND_INDEX,
} = require('./benchmark-state')

const OPERATIONS = Number(process.env.OPERATIONS)
const STARTUP_GUARD_MAX_SHARE = Number(process.env.STARTUP_GUARD_MAX_SHARE)
const TRACK_PROBE_OUTPUT = process.env.TRACK_PROBE_OUTPUT === 'true'
const EXPECTED_CAPTURE_KIND = process.env.EXPECTED_CAPTURE_KIND
const OUTPUT_TIMEOUT = 15_000
const dataFixture = createData()

// The devtools worker and its ports are unref'd, so nothing holds the event
// loop open while the breakpoint installs or while the app awaits final output.
const keepAlive = setInterval(() => {}, 2 ** 31 - 1)
const debuggerBenchmark = require('./start-devtools-client')
const { probeCounts, stop } = debuggerBenchmark
debuggerBenchmark.start(() => {
  if (!TRACK_PROBE_OUTPUT) clearInterval(keepAlive)
  setImmediate(TRACK_PROBE_OUTPUT ? preflightProbe : runLoop)
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
 * Run one continuous hot loop, then wait for every production pause handler.
 * The final barrier makes completed work exact without adding work between hits.
 *
 * @returns {void}
 */
function runCapturedLoop () {
  guard.loopStart()
  for (let i = 0; i < OPERATIONS; i++) doSomeWork(i)

  if (!probeCounts) throw new Error('debugger completion counter was not initialized')
  const expectedProbes = OPERATIONS
  waitForProbeHandlers(probeCounts, expectedProbes, () => {
    validateProbePayloads(probeCounts, expectedProbes)
    validateMeasuredCaptureKinds(probeCounts, expectedProbes)
    stop()
    finish()
  })
}

/**
 * Wait without blocking the application thread until the debugger worker has
 * finished each production pause handler.
 *
 * @param {Int32Array} counter
 * @param {number} expected
 * @param {() => void} done
 * @returns {void}
 */
function waitForProbeHandlers (counter, expected, done) {
  const actual = Atomics.load(counter, HANDLED_PROBE_INDEX)
  if (actual === expected) return done()
  if (actual > expected) throw new Error(`debugger handled ${actual} of ${expected} expected breakpoint events`)

  const waiter = Atomics.waitAsync(counter, HANDLED_PROBE_INDEX, actual, OUTPUT_TIMEOUT)
  if (waiter.async) {
    waiter.value.then(result => finishHandlerWait(counter, expected, done, result))
  } else {
    finishHandlerWait(counter, expected, done, waiter.value)
  }
}

/**
 * Validate the worker handler count after an atomic wait.
 *
 * @param {Int32Array} counter
 * @param {number} expected
 * @param {() => void} done
 * @param {'ok' | 'not-equal' | 'timed-out'} result
 * @returns {void}
 */
function finishHandlerWait (counter, expected, done, result) {
  const actual = Atomics.load(counter, HANDLED_PROBE_INDEX)
  if (actual === expected) return done()
  if (result === 'timed-out' || actual > expected) {
    throw new Error(`debugger handled ${actual} of ${expected} expected breakpoint events`)
  }

  waitForProbeHandlers(counter, expected, done)
}

/**
 * Ensure each handled breakpoint produces one payload.
 *
 * @param {Int32Array} counts
 * @param {number} completed
 * @returns {void}
 */
function validateProbePayloads (counts, completed) {
  const payloads = Atomics.load(counts, COMPLETED_PROBE_INDEX)
  if (payloads !== completed) {
    throw new Error(`debugger completed ${payloads} of ${completed} expected probe payloads`)
  }
}

/**
 * Ensure each measured payload uses the expected capture mode.
 *
 * @param {Int32Array} counts
 * @param {number} completed
 * @returns {void}
 */
function validateMeasuredCaptureKinds (counts, completed) {
  const matched = Atomics.load(counts, MATCHED_CAPTURE_KIND_INDEX)
  if (matched !== completed) {
    throw new Error(
      `debugger produced ${matched} of ${completed} expected ${EXPECTED_CAPTURE_KIND} capture payloads`
    )
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
  const arr = Array.from({ length: 1000 }, (_, i) => i)

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

/**
 * Prove the selected capture path once before starting the measured loop.
 *
 * @returns {void}
 */
function preflightProbe () {
  if (!probeCounts) throw new Error('debugger completion counter was not initialized')

  doSomeWork(0)
  waitForProbeHandlers(probeCounts, 1, () => {
    validateProbePayloads(probeCounts, 1)
    validateCaptureKind(probeCounts)
    resetProbeCounts(probeCounts)
    setImmediate(runCapturedLoop)
  })
}

/**
 * Ensure the payload shape reflects the selected capture limits.
 *
 * @param {Int32Array} counts
 * @returns {void}
 */
function validateCaptureKind (counts) {
  const expected = CAPTURE_KINDS[EXPECTED_CAPTURE_KIND]
  if (expected === undefined) {
    throw new Error(`unknown expected debugger capture kind: ${EXPECTED_CAPTURE_KIND}`)
  }

  const actual = Atomics.load(counts, CAPTURE_KIND_INDEX)
  if (actual !== expected) {
    throw new Error(
      `debugger produced ${CAPTURE_KIND_NAMES[actual] ?? 'unknown'} capture output; expected ${EXPECTED_CAPTURE_KIND}`
    )
  }
}

/**
 * Reset preflight state so only measured probe output contributes to completion.
 *
 * @param {Int32Array} counts
 * @returns {void}
 */
function resetProbeCounts (counts) {
  for (let i = 0; i < counts.length; i++) Atomics.store(counts, i, 0)
}
