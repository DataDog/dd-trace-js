'use strict'

const telemetryMetrics = require('../../telemetry/metrics')

const metrics = telemetryMetrics.manager.namespace('general')

const DROP_REASONS = new Set([
  'pre_queue_overflow',
  'queue_overflow',
  'closed',
  'unavailable',
  'degraded_cap',
  'payload_limit',
  'serialization_error',
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

/**
 * Best-effort telemetry must never affect an evaluation or writer drain.
 *
 * @param {string} name - Bounded metric name
 * @param {number} value - Count to add
 * @param {string} [reason] - Bounded reason tag
 */
function count (name, value, reason) {
  if (!Number.isSafeInteger(value) || value <= 0) return
  try {
    metrics.count(name, reason === undefined ? undefined : { reason }).inc(value)
  } catch {}
}

/**
 * @param {string} reason
 * @param {number} [value]
 */
function recordDropped (reason, value = 1) {
  if (DROP_REASONS.has(reason)) count('flagevaluation.rows.dropped', value, reason)
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
  recordContextTruncated,
  recordDegraded,
  recordDropped,
  recordHookError,
  recordPayloadSplit,
  recordTargetingKeyOmitted,
}
