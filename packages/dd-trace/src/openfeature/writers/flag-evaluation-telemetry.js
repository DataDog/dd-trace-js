'use strict'

let metrics
/** @type {Int32Array | undefined} */
let workerState

// Namespace resets clear points, not metric instances. Names and reasons are fixed below.
/** @type {Map<string, { inc: (value: number) => void }>} */
const countMetrics = new Map()

const DROP_REASONS = new Set([
  'pre_queue_overflow',
  'queue_overflow',
  'closed',
  'unavailable',
  'degraded_cap',
  'payload_limit',
  'serialization_error',
  // Discarded after failed delivery; an ambiguous response does not prove the receiver lost the batch.
  'delivery_failure',
  'worker_failure',
  'shutdown_timeout',
])
const DEGRADE_REASONS = new Set(['cardinality_cap', 'payload_limit'])
const CONTEXT_REASONS = new Set([
  'max_context_fields',
  'max_key_length',
  'max_value_length',
  'max_list_elements',
  'max_structure_properties',
  'max_snapshot_depth',
  'max_visited_nodes',
  'cycle',
  'invalid_encoding',
  'unsupported_type',
  'snapshot_error',
])

// Slot 0 owns admitted input until aggregation; slot 1 owns all accepted observations until delivery/drop.
// Fixed metric slots follow. Only the application drains them; no message per event or flush.
/** @type {Array<[string, string | undefined]>} */
const metricKeys = [
  ...[...DROP_REASONS].map(reason => /** @type {[string, string]} */ (['flagevaluation.rows.dropped', reason])),
  ...[...DEGRADE_REASONS].map(reason => /** @type {[string, string]} */ (['flagevaluation.rows.degraded', reason])),
  ...[...CONTEXT_REASONS].map(reason => /** @type {[string, string]} */ (['flagevaluation.context.truncated', reason])),
  ['flagevaluation.payload.splits', undefined],
  ['flagevaluation.targeting_key.omitted', 'invalid'],
  ['flagevaluation.hook.errors', undefined],
]
const metricSlots = new Map(metricKeys.map(([name, reason], index) => [name + ':' + reason, index + 2]))

/** @param {Int32Array} state */
function configureWorkerTelemetry (state) {
  workerState = state
}

function createWorkerState () {
  return new Int32Array(new SharedArrayBuffer((metricKeys.length + 2) * Int32Array.BYTES_PER_ELEMENT))
}

/** @param {Int32Array} state */
function collectWorkerTelemetry (state) {
  for (let i = 0; i < metricKeys.length; i++) {
    const value = Atomics.exchange(state, i + 2, 0)
    const [name, reason] = metricKeys[i]
    count(name, value, reason)
  }
}

/**
 * Best-effort telemetry must never affect an evaluation or writer drain.
 *
 * @param {string} name - Bounded metric name
 * @param {number} value - Count to add
 * @param {string} [reason] - Bounded reason tag
 */
function count (name, value, reason) {
  if (!Number.isSafeInteger(value) || value <= 0) return
  if (workerState) {
    const slot = /** @type {number} */ (metricSlots.get(name + ':' + reason))
    // Saturate instead of wrapping if the application stops collecting metrics for a long time.
    let previous = Atomics.load(workerState, slot)
    while (Atomics.compareExchange(workerState, slot, previous,
      Math.min(0x7F_FF_FF_FF, previous + value)) !== previous) {
      previous = Atomics.load(workerState, slot)
    }
    return
  }
  try {
    const id = name + ':' + reason
    let metric = countMetrics.get(id)
    if (metric === undefined) {
      metrics ??= require('../../telemetry/metrics').manager.namespace('general')
      metric = /** @type {{ inc: (value: number) => void }} */ (
        metrics.count(name, reason === undefined ? undefined : { reason })
      )
      countMetrics.set(id, metric)
    }
    metric.inc(value)
  } catch {}
}

/**
 * @param {string} reason
 * @param {number} [value]
 */
function recordDropped (reason, value = 1) {
  if (!DROP_REASONS.has(reason)) return
  if (workerState && Number.isSafeInteger(value) && value > 0) Atomics.sub(workerState, 1, value)
  count('flagevaluation.rows.dropped', value, reason)
}

/**
 * @param {string} reason
 * @param {number} [value]
 */
function recordDegraded (reason, value = 1) {
  if (DEGRADE_REASONS.has(reason)) count('flagevaluation.rows.degraded', value, reason)
}

/** @param {number} [value] */
function recordPayloadSplit (value = 1) {
  count('flagevaluation.payload.splits', value)
}

/**
 * @param {string} reason
 * @param {number} [value]
 */
function recordContextTruncated (reason, value = 1) {
  if (CONTEXT_REASONS.has(reason)) count('flagevaluation.context.truncated', value, reason)
}

/** @param {number} [value] */
function recordTargetingKeyOmitted (value = 1) {
  count('flagevaluation.targeting_key.omitted', value, 'invalid')
}

/** @param {number} [value] */
function recordHookError (value = 1) {
  count('flagevaluation.hook.errors', value)
}

module.exports = {
  collectWorkerTelemetry,
  configureWorkerTelemetry,
  createWorkerState,
  recordContextTruncated,
  recordDegraded,
  recordDropped,
  recordHookError,
  recordPayloadSplit,
  recordTargetingKeyOmitted,
}
