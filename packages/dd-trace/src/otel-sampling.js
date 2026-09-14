'use strict'

const { AUTO_KEEP } = require('../../../ext/priority')
const knuthHash = require('./knuth-hash')
const { SAMPLING_AGENT_DECISION, SAMPLING_RULE_DECISION } = require('./constants')

const MAX_OTEL_VALUE_BYTES = 256
const MAX_THRESHOLD = 2n ** 56n
const MAX_ENCODABLE_THRESHOLD = MAX_THRESHOLD - 1n
const UINT64_MASK = 2n ** 64n - 1n

/**
 * @param {unknown} value
 * @param {number} minLength
 * @param {number} maxLength
 * @returns {value is string}
 */
function isLowerHex (value, minLength, maxLength) {
  if (typeof value !== 'string' || value.length < minLength || value.length > maxLength) return false

  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if ((code < 48 || code > 57) && (code < 97 || code > 102)) return false
  }

  return true
}

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
 * @param {number} probabilityRate
 * @returns {{ randomValue: string, threshold: string } | undefined}
 */
function generateFields (context, probabilityRate) {
  const { priority } = context._sampling
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
 * Returns the probability rate recorded by a committed Datadog sampling decision.
 * Sampling probes deliberately leave these rate fields unset.
 *
 * @param {import('./opentracing/span_context')} context
 * @returns {number | undefined}
 */
function getProbabilityRate (context) {
  if (context._sampling.isProbabilityDecision === false) return
  return (context._trace[SAMPLING_RULE_DECISION] ?? context._trace[SAMPLING_AGENT_DECISION]) || undefined
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
  const probabilityRate = getProbabilityRate(context)
  if (context._sampling.isProbabilityDecision === false) {
    if (otelMember === undefined) return
  } else if (probabilityRate === undefined) {
    return
  }

  traceState.forVendor('ot', state => {
    let randomValue = state.get('rv')
    let threshold = state.get('th')

    if (!isLowerHex(randomValue, 14, 14)) {
      state.delete('rv')
      randomValue = undefined
    }
    if (!isLowerHex(threshold, 1, 14)) {
      state.delete('th')
      threshold = undefined
    }

    if (context._sampling.isProbabilityDecision === false) {
      state.delete('th')
    } else if (randomValue === undefined && threshold === undefined) {
      const generated = generateFields(context, probabilityRate)
      if (generated) {
        // Entries serialize in reverse insertion order, so add th before rv.
        state.set('th', generated.threshold)
        state.set('rv', generated.randomValue)
      }
    }
  }, MAX_OTEL_VALUE_BYTES)
}

module.exports = {
  updateOtelTraceState,
}
