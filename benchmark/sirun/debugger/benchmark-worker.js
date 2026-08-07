'use strict'

const { workerData } = require('node:worker_threads')

const {
  CAPTURED_PROBE_INDEX,
  CAPTURE_KIND_INDEX,
  CAPTURE_KINDS,
  COMPLETED_PROBE_INDEX,
} = require('./benchmark-state')

require('../noop-request')

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

require('../../../packages/dd-trace/src/debugger/devtools_client')

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
 * Record completion after the production worker has captured and formatted the
 * probe output. The one preflight payload is inspected but not buffered.
 *
 * @param {string} message
 * @param {Record<string, unknown>} logger
 * @param {Record<string, unknown> | undefined} dd
 * @param {DebuggerSnapshot} snapshot
 * @param {string | undefined} processTags
 * @returns {void}
 */
function sendAndCount (message, logger, dd, snapshot, processTags) {
  if (preflightPending) {
    preflightPending = false
    Atomics.store(probeCounts, CAPTURE_KIND_INDEX, getCaptureKind(snapshot))
  } else {
    send(message, logger, dd, snapshot, processTags)
  }

  if (snapshot.captures !== undefined) Atomics.add(probeCounts, CAPTURED_PROBE_INDEX, 1)
  Atomics.add(probeCounts, COMPLETED_PROBE_INDEX, 1)
  Atomics.notify(probeCounts, COMPLETED_PROBE_INDEX)
}

/**
 * Classify the preflight output by the production capture shape.
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
