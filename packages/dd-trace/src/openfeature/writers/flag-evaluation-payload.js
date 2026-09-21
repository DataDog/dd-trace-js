'use strict'

const { types: { isProxy } } = require('node:util')

const { EVP_EVENT_SIZE_LIMIT, EVP_PAYLOAD_SIZE_LIMIT } = require('../constants/constants')
const { hashTargetingKey, normalizeTargetingKey, protectedErrorCode } = require('./flag-evaluation-pii')
const { recordDegraded, recordDropped, recordPayloadSplit } = require('./flag-evaluation-telemetry')

/** @param {unknown} attrs */
function safeAttrs (attrs) {
  if (attrs === null || typeof attrs !== 'object' || isProxy(attrs)) return
  const prototype = Object.getPrototypeOf(attrs)
  if (prototype !== null && prototype !== Object.prototype) return
  const output = Object.create(null)
  let hasAttrs = false
  for (const key of Object.keys(attrs)) {
    const descriptor = Object.getOwnPropertyDescriptor(attrs, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) continue
    const value = descriptor.value
    if (normalizeTargetingKey(key) === undefined) continue
    if (value === null || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && normalizeTargetingKey(value) !== undefined)) {
      output[key] = value
      hasAttrs = true
    }
  }
  return hasAttrs ? output : undefined
}

function makeRow (entry, timestamp, degraded) {
  const flagKey = normalizeTargetingKey(entry.flagKey)
  if (flagKey === undefined || !Number.isSafeInteger(entry.first) || !Number.isSafeInteger(entry.last) ||
    !Number.isSafeInteger(entry.count) || entry.count < 1) return
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
    const attrs = entry.consent === true ? safeAttrs(entry.attrs) : undefined
    if (attrs !== undefined) row.context = { evaluation: attrs }
  }
  return row
}

/**
 * Serialize aggregate maps into exact EVP envelopes.
 *
 * @param {Map<string, object>} full
 * @param {Map<string, object>} degraded
 * @param {object} context
 * @param {number} timestamp
 * @returns {Array<{ encoded: string, rows: number }>}
 */
function buildFlagEvaluationPayloads (full, degraded, context, timestamp) {
  const prefix = '{"context":' + JSON.stringify(context) + ',"flagEvaluations":['
  const suffix = ']}'
  const payloads = []
  let encodedRows = []
  let size = Buffer.byteLength(prefix) + Buffer.byteLength(suffix)

  const close = () => {
    if (encodedRows.length === 0) return
    payloads.push({ encoded: prefix + encodedRows.join(',') + suffix, rows: encodedRows.length })
    encodedRows = []
    size = Buffer.byteLength(prefix) + Buffer.byteLength(suffix)
  }

  const entries = []
  for (const entry of full.values()) entries.push([entry, false])
  for (const entry of degraded.values()) entries.push([entry, true])

  for (const [entry, aggregateDegraded] of entries) {
    let row = makeRow(entry, timestamp, aggregateDegraded)
    if (row === undefined) {
      recordDropped('serialization_error', entry.count)
      continue
    }
    let encoded
    try {
      encoded = JSON.stringify(row)
    } catch {
      recordDropped('serialization_error', row.evaluation_count)
      continue
    }

    let canDegrade = row.targeting_key !== undefined || row.context !== undefined
    const degrade = () => {
      if (!canDegrade) return false
      row = { ...row }
      delete row.targeting_key
      delete row.context
      encoded = JSON.stringify(row)
      recordDegraded('payload_limit', row.evaluation_count)
      canDegrade = false
      return true
    }

    try {
      if (Buffer.byteLength(encoded) > EVP_EVENT_SIZE_LIMIT) degrade()
    } catch {
      recordDropped('serialization_error', row.evaluation_count)
      continue
    }
    if (Buffer.byteLength(encoded) > EVP_EVENT_SIZE_LIMIT) {
      recordDropped('payload_limit', row.evaluation_count)
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
        recordDropped('serialization_error', row.evaluation_count)
        continue
      }
    }
    if (size + addition > EVP_PAYLOAD_SIZE_LIMIT) {
      recordDropped('payload_limit', row.evaluation_count)
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
