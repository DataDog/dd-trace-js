'use strict'

const { EVP_EVENT_SIZE_LIMIT, EVP_PAYLOAD_SIZE_LIMIT } = require('../constants/constants')
const { validateContextSnapshot } = require('./flag-evaluation-context')
const { hashTargetingKey, normalizeTargetingKey, protectedErrorCode } = require('./flag-evaluation-pii')
const { recordDegraded, recordDropped, recordPayloadSplit } = require('./flag-evaluation-telemetry')

/** @typedef {import('./flag-evaluation-aggregation').AggregationEntry} AggregationEntry */
/** @typedef {import('./flag-evaluation-context').ContextSnapshot} ContextSnapshot */
/**
 * @typedef {object} FlagEvaluationBatchContext
 * @property {string} service
 * @property {string} [env]
 * @property {string} [version]
 */
/**
 * @typedef {object} FlagEvaluationRow
 * @property {number} timestamp
 * @property {{ key: string }} flag
 * @property {number} first_evaluation
 * @property {number} last_evaluation
 * @property {number} evaluation_count
 * @property {boolean} [runtime_default_used]
 * @property {string} [targeting_key]
 * @property {{ evaluation: ContextSnapshot }} [context]
 * @property {{ key: string }} [variant]
 * @property {{ key: string }} [allocation]
 * @property {{ key: string }} [targeting_rule]
 * @property {{ message: string }} [error]
 */
/** @typedef {{ encoded: string, rows: number }} EncodedFlagEvaluationPayload */

/**
 * @param {AggregationEntry} entry
 * @param {number} timestamp
 * @param {boolean} degraded
 * @returns {FlagEvaluationRow | undefined}
 */
function makeRow (entry, timestamp, degraded) {
  const flagKey = normalizeTargetingKey(entry.flagKey)
  if (flagKey === undefined || !Number.isSafeInteger(entry.first) || !Number.isSafeInteger(entry.last) ||
    !Number.isSafeInteger(entry.count) || entry.count < 1) return
  /** @type {FlagEvaluationRow} */
  const row = {
    timestamp,
    flag: { key: flagKey },
    first_evaluation: entry.first,
    last_evaluation: entry.last,
    evaluation_count: entry.count,
  }
  if (entry.runtimeDefault === true) row.runtime_default_used = true
  const variant = normalizeTargetingKey(entry.variant)
  const allocation = normalizeTargetingKey(entry.allocation)
  const rule = normalizeTargetingKey(entry.rule)
  if (variant) row.variant = { key: variant }
  if (allocation) row.allocation = { key: allocation }
  if (rule) row.targeting_rule = { key: rule }
  const error = protectedErrorCode(entry.error)
  if (error !== undefined) row.error = { message: error }
  if (!degraded) {
    const targetingKey = entry.consent === true
      ? normalizeTargetingKey(entry.rawTargetingKey)
      : hashTargetingKey(entry.rawTargetingKey)
    if (targetingKey !== undefined) row.targeting_key = targetingKey
    const attrs = entry.consent === true ? validateContextSnapshot(entry.attrs) : undefined
    if (attrs !== undefined) row.context = { evaluation: attrs }
  }
  return row
}

/**
 * Serialize aggregate maps into exact EVP envelopes.
 *
 * @param {Map<string, AggregationEntry>} full
 * @param {Map<string, AggregationEntry>} degraded
 * @param {FlagEvaluationBatchContext} context
 * @param {number} timestamp
 * @returns {EncodedFlagEvaluationPayload[]}
 */
function buildFlagEvaluationPayloads (full, degraded, context, timestamp) {
  const prefix = '{"context":' + JSON.stringify(context) + ',"flagEvaluations":['
  const suffix = ']}'
  /** @type {EncodedFlagEvaluationPayload[]} */
  const payloads = []
  /** @type {string[]} */
  let encodedRows = []
  let size = Buffer.byteLength(prefix) + Buffer.byteLength(suffix)

  const close = () => {
    if (encodedRows.length === 0) return
    payloads.push({ encoded: prefix + encodedRows.join(',') + suffix, rows: encodedRows.length })
    encodedRows = []
    size = Buffer.byteLength(prefix) + Buffer.byteLength(suffix)
  }

  /** @type {Array<[AggregationEntry, boolean]>} */
  const entries = []
  for (const entry of full.values()) entries.push([entry, false])
  for (const entry of degraded.values()) entries.push([entry, true])

  for (const [entry, aggregateDegraded] of entries) {
    const row = makeRow(entry, timestamp, aggregateDegraded)
    if (row === undefined) {
      recordDropped('serialization_error', entry.count)
      continue
    }
    let serializedRow = row
    let encoded
    try {
      encoded = JSON.stringify(serializedRow)
    } catch {
      recordDropped('serialization_error', serializedRow.evaluation_count)
      continue
    }

    let canDegrade = serializedRow.targeting_key !== undefined || serializedRow.context !== undefined
    const degrade = () => {
      if (!canDegrade) return false
      serializedRow = { ...serializedRow }
      delete serializedRow.targeting_key
      delete serializedRow.context
      encoded = JSON.stringify(serializedRow)
      recordDegraded('payload_limit', serializedRow.evaluation_count)
      canDegrade = false
      return true
    }

    try {
      if (Buffer.byteLength(encoded) > EVP_EVENT_SIZE_LIMIT) degrade()
    } catch {
      recordDropped('serialization_error', serializedRow.evaluation_count)
      continue
    }
    if (Buffer.byteLength(encoded) > EVP_EVENT_SIZE_LIMIT) {
      recordDropped('payload_limit', serializedRow.evaluation_count)
      continue
    }

    let addition = Buffer.byteLength(encoded) + Number(encodedRows.length > 0)
    if (size + addition > EVP_PAYLOAD_SIZE_LIMIT && encodedRows.length > 0) {
      close()
      addition = Buffer.byteLength(encoded)
    }
    if (size + addition > EVP_PAYLOAD_SIZE_LIMIT) {
      try {
        if (degrade()) addition = Buffer.byteLength(encoded)
      } catch {
        recordDropped('serialization_error', serializedRow.evaluation_count)
        continue
      }
    }
    if (size + addition > EVP_PAYLOAD_SIZE_LIMIT) {
      recordDropped('payload_limit', serializedRow.evaluation_count)
      continue
    }
    encodedRows.push(encoded)
    size += addition
  }
  close()
  if (payloads.length > 1) recordPayloadSplit(payloads.length - 1)
  return payloads
}

module.exports = { buildFlagEvaluationPayloads }
