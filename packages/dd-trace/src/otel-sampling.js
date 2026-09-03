'use strict'

const { AUTO_KEEP } = require('../../../ext/priority')
const knuthHash = require('./knuth-hash')

const MAX_OTEL_VALUE_BYTES = 256
const MAX_THRESHOLD = 2n ** 56n
const MAX_ENCODABLE_THRESHOLD = MAX_THRESHOLD - 1n
const UINT64_MASK = 2n ** 64n - 1n
const validRandomValue = /^[0-9a-f]{14}$/
const validThreshold = /^[0-9a-f]{1,14}$/

/**
 * Derives the OTel 56-bit random value from Datadog's sampling hash.
 *
 * @param {bigint} traceId
 * @returns {bigint}
 */
function randomValueFor (traceId) {
  return ((~knuthHash(traceId)) & UINT64_MASK) >> 8n
}

/**
 * Converts a sample rate to an OTel 56-bit rejection threshold.
 *
 * @param {number} sampleRate
 * @returns {bigint}
 */
function thresholdFor (sampleRate) {
  if (sampleRate === 1) return 0n
  if (sampleRate === 0) return MAX_ENCODABLE_THRESHOLD

  const threshold = BigInt(Math.round((1 - sampleRate) * Number(MAX_THRESHOLD)))
  if (threshold < 0n) return 0n
  if (threshold > MAX_ENCODABLE_THRESHOLD) return MAX_ENCODABLE_THRESHOLD
  return threshold
}

/**
 * Formats an OTel threshold with trailing zero nibbles removed.
 *
 * @param {bigint} threshold
 * @returns {string}
 */
function formatThreshold (threshold) {
  return threshold.toString(16).padStart(14, '0').replace(/0+$/, '') || '0'
}

/**
 * Generates OTel sampling fields for a local probability decision.
 *
 * @param {import('./opentracing/span_context')} context
 * @returns {{ randomValue: string, threshold: string } | undefined}
 */
function generateFields (context) {
  const { priority } = context._sampling
  const probabilityRate = getProbabilityRate(context)
  if (priority === undefined || probabilityRate === undefined) return

  const thresholdValue = thresholdFor(probabilityRate)
  let randomValue = randomValueFor(context._traceId.toBigInt())
  const kept = priority >= AUTO_KEEP

  if (kept && randomValue < thresholdValue) {
    randomValue = thresholdValue
  } else if (!kept && randomValue >= thresholdValue) {
    randomValue = thresholdValue > 0n ? thresholdValue - 1n : 0n
  }

  return {
    randomValue: randomValue.toString(16).padStart(14, '0'),
    threshold: formatThreshold(thresholdValue),
  }
}

/**
 * Returns the probability rate already recorded by the regular Datadog sampling path.
 *
 * @param {import('./opentracing/span_context')} context
 * @returns {number | undefined}
 */
function getProbabilityRate (context) {
  if (context._sampling.isProbabilityDecision === true) return context._sampling.probabilityRate
}

/**
 * Adds a complete sub-field while the OTel member remains within its byte cap.
 *
 * @param {string[]} fields
 * @param {string} field
 * @param {number} byteLength
 * @returns {number}
 */
function addField (fields, field, byteLength) {
  const fieldLength = Buffer.byteLength(field) + (fields.length === 0 ? 0 : 1)
  if (byteLength + fieldLength <= MAX_OTEL_VALUE_BYTES) {
    fields.push(field)
    return byteLength + fieldLength
  }
  return byteLength
}

/**
 * Parses and rebuilds the OTel tracestate member, preserving unknown sub-fields.
 *
 * @param {import('./opentracing/span_context')} context
 * @param {string | undefined} member
 * @returns {string | undefined}
 */
function buildOtelMember (context, member) {
  if (member === undefined) {
    if (context._sampling.isProbabilityDecision === false) return
    const generated = generateFields(context)
    if (!generated) return
    return `rv:${generated.randomValue};th:${generated.threshold}`
  }

  let randomValue
  let threshold
  const unknownFields = []
  let start = 0

  while (start <= member.length) {
    let end = member.indexOf(';', start)
    if (end === -1) end = member.length
    const field = member.slice(start, end)
    if (field) {
      const separator = field.indexOf(':')
      const key = separator === -1 ? field : field.slice(0, separator)
      const value = separator === -1 ? undefined : field.slice(separator + 1)
      if (key === 'rv') {
        randomValue = value
      } else if (key === 'th') {
        threshold = value
      } else {
        unknownFields.push(field)
      }
    }
    if (end === member.length) break
    start = end + 1
  }

  if (!validRandomValue.test(randomValue)) randomValue = undefined
  if (!validThreshold.test(threshold)) threshold = undefined

  if (context._sampling.isProbabilityDecision === false) {
    threshold = undefined
  } else if (randomValue === undefined && threshold === undefined) {
    const generated = generateFields(context)
    if (generated) {
      randomValue = generated.randomValue
      threshold = generated.threshold
    }
  }

  const fields = []
  let byteLength = 0
  if (randomValue !== undefined) byteLength = addField(fields, `rv:${randomValue}`, byteLength)
  if (threshold !== undefined) byteLength = addField(fields, `th:${threshold}`, byteLength)
  for (const field of unknownFields) {
    byteLength = addField(fields, field, byteLength)
  }

  return fields.length === 0 ? undefined : fields.join(';')
}

/**
 * Updates the OTel tracestate member to represent the context's sampling decision.
 *
 * @param {import('./opentracing/span_context')} context
 * @param {import('./opentracing/propagation/tracestate')} traceState
 * @returns {void}
 */
function updateOtelTraceState (context, traceState) {
  const otelMember = traceState.get('ot')
  if (context._sampling.isProbabilityDecision === false) {
    if (otelMember === undefined) return
  } else if (getProbabilityRate(context) === undefined) {
    // Reinsert the inherited member to keep it leftmost without rebuilding its fields.
    if (otelMember !== undefined) traceState.set('ot', otelMember)
    return
  }

  const rebuiltOtelMember = buildOtelMember(context, otelMember)
  if (rebuiltOtelMember === undefined) {
    traceState.delete('ot')
  } else {
    traceState.set('ot', rebuiltOtelMember)
  }
}

module.exports = {
  buildOtelMember,
  updateOtelTraceState,
}
