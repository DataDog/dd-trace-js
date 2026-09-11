'use strict'

const { workerData } = require('node:worker_threads')

const {
  CAPTURE_KIND_INDEX,
  CAPTURE_KINDS,
  COMPLETED_PROBE_INDEX,
  HANDLED_PROBE_INDEX,
  MATCHED_CAPTURE_KIND_INDEX,
} = require('./benchmark-state')

require('../noop-request')

const EXPECTED_CAPTURE_KIND = CAPTURE_KINDS[process.env.EXPECTED_CAPTURE_KIND]

/** @type {Int32Array | undefined} */
let probeCounts
/** @type {typeof import('../../../packages/dd-trace/src/debugger/devtools_client/send') | undefined} */
let send
let preflightPending = true

if (workerData.probeCountBuffer !== undefined) {
  probeCounts = new Int32Array(workerData.probeCountBuffer)
  const sendPath = require.resolve('../../../packages/dd-trace/src/debugger/devtools_client/send')
  send = require(sendPath)
  require.cache[sendPath] = { exports: sendAndCount }
}

loadDevtoolsClient()

/**
 * @typedef {object} CapturedValue
 * @property {Record<string, CapturedValue>} [fields]
 */

/**
 * @typedef {object} DebuggerSnapshot
 * @property {{ location: { lines: string[] } }} probe
 * @property {{ lines: Record<string, { locals?: Record<string, CapturedValue> }> }} [captures]
 */

/**
 * Load the production client with its pause handler wrapped so the application
 * can wait for post-resume formatting to finish.
 *
 * @returns {void}
 */
function loadDevtoolsClient () {
  const session = require('../../../packages/dd-trace/src/debugger/devtools_client/session')
  const originalOn = session.on
  /**
   * @param {string | symbol} eventName
   * @param {(...args: unknown[]) => void} listener
   * @returns {import('node:events').EventEmitter}
   */
  session.on = function benchmarkOn (eventName, listener) {
    if (eventName !== 'Debugger.paused' || probeCounts === undefined) {
      return originalOn.call(this, eventName, listener)
    }

    const paused = /** @type {(event: object) => Promise<void>} */ (listener)
    /**
     * @param {object} event
     * @returns {void}
     */
    function benchmarkPaused (event) {
      paused.call(this, event).then(markProbeHandled)
    }

    return originalOn.call(this, eventName, benchmarkPaused)
  }

  try {
    require('../../../packages/dd-trace/src/debugger/devtools_client')
  } finally {
    session.on = originalOn
  }
}

function markProbeHandled () {
  Atomics.add(probeCounts, HANDLED_PROBE_INDEX, 1)
  Atomics.notify(probeCounts, HANDLED_PROBE_INDEX)
}

/**
 * Record completion after the production worker has captured and formatted the
 * probe output. The one preflight payload is inspected but not buffered.
 *
 * @param {string} message
 * @param {Record<string, unknown>} logger
 * @param {Record<string, unknown> | undefined} dd
 * @param {DebuggerSnapshot} snapshot
 * @param {string | undefined} processTags
 * @param {number} eventType
 * @param {number} incompleteReasons
 * @returns {void}
 */
function sendAndCount (message, logger, dd, snapshot, processTags, eventType, incompleteReasons) {
  const captureKind = getCaptureKind(snapshot)
  if (preflightPending) {
    preflightPending = false
    Atomics.store(probeCounts, CAPTURE_KIND_INDEX, captureKind)
  } else {
    send(message, logger, dd, snapshot, processTags, eventType, incompleteReasons)
    if (captureKind === EXPECTED_CAPTURE_KIND) Atomics.add(probeCounts, MATCHED_CAPTURE_KIND_INDEX, 1)
  }

  Atomics.add(probeCounts, COMPLETED_PROBE_INDEX, 1)
  Atomics.notify(probeCounts, COMPLETED_PROBE_INDEX)
}

/**
 * Classify output by the production capture shape.
 *
 * @param {DebuggerSnapshot} snapshot
 * @returns {number}
 */
function getCaptureKind (snapshot) {
  if (snapshot.captures === undefined) return CAPTURE_KINDS.none

  const line = snapshot.probe.location.lines[0]
  const locals = snapshot.captures.lines[line]?.locals
  const data = locals?.data
  if (locals !== undefined && data === undefined) return CAPTURE_KINDS.minimal
  if (data?.fields !== undefined) return CAPTURE_KINDS.default
  return 0
}
