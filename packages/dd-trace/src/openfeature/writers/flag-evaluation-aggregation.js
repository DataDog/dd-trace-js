'use strict'

const {
  FLAG_EVALUATION_DEGRADED_CAP,
  FLAG_EVALUATION_GLOBAL_CAP,
  FLAG_EVALUATION_PER_FLAG_CAP,
} = require('../constants/constants')
const { validatedContextEntries, snapshotFromEntries } = require('./flag-evaluation-context')
const { prefixedTargetingKeyDigest, normalizeTargetingKey, protectedErrorCode } = require('./flag-evaluation-pii')
const { recordDegraded, recordDropped } = require('./flag-evaluation-telemetry')

/** @typedef {import('./flag-evaluation-context').ContextSnapshot} ContextSnapshot */
/**
 * @typedef {object} FlagEvaluationEvent
 * @property {string} flagKey
 * @property {string} [variant]
 * @property {string} [allocationKey]
 * @property {string} [targetingRuleKey]
 * @property {boolean} runtimeDefault
 * @property {unknown} [errorCode]
 * @property {unknown} [targetingKey]
 * @property {ContextSnapshot} [attrs]
 * @property {unknown} [observeFullEvaluationData]
 * @property {number} timestamp
 */
/**
 * @typedef {object} AggregationDimensions
 * @property {string} flagKey
 * @property {string} [variant]
 * @property {string} [allocation]
 * @property {string} [rule]
 * @property {string} [error]
 */
/**
 * @typedef {AggregationDimensions & {
 *   runtimeDefault: boolean,
 *   rawTargetingKey?: string,
 *   attrs?: ContextSnapshot,
 *   consent: boolean,
 *   count: number,
 *   first: number,
 *   last: number
 * }} AggregationEntry
 */
/**
 * @typedef {object} AggregationResult
 * @property {Map<string, AggregationEntry>} full
 * @property {Map<string, AggregationEntry>} degraded
 */

/** @param {unknown} value */
function optionalKey (value) {
  const key = normalizeTargetingKey(value)
  return key === undefined || key.length === 0 ? undefined : key
}

/**
 * Merge one observation into an aggregation entry.
 *
 * @param {AggregationEntry} entry
 * @param {number} timestamp
 * @param {unknown} consent
 */
function observeEntry (entry, timestamp, consent) {
  entry.count++
  entry.first = Math.min(entry.first, timestamp)
  entry.last = Math.max(entry.last, timestamp)
  entry.consent &&= consent === true
}

/** @param {Map<string, AggregationEntry>} entries */
function evaluationCount (entries) {
  let count = 0
  for (const entry of entries.values()) count += entry.count
  return count
}

class FlagEvaluationAggregator {
  /** @type {Map<string, AggregationEntry>} */
  #full = new Map()
  /** @type {Map<string, AggregationEntry>} */
  #degraded = new Map()
  /** @type {Map<string, number>} */
  #perFlag = new Map()

  /** @param {FlagEvaluationEvent} event */
  add (event) {
    const flagKey = normalizeTargetingKey(event.flagKey)
    if (flagKey === undefined || !Number.isSafeInteger(event.timestamp)) {
      recordDropped('serialization_error')
      return
    }
    const consent = event.observeFullEvaluationData === true
    const targetingKey = normalizeTargetingKey(event.targetingKey)
    const contextEntries = consent ? validatedContextEntries(event.attrs) : undefined
    const protectedKey = consent ? targetingKey : prefixedTargetingKeyDigest(targetingKey)
    const error = protectedErrorCode(event.errorCode)
    const variant = optionalKey(event.variant)
    const allocation = optionalKey(event.allocationKey)
    const rule = optionalKey(event.targetingRuleKey)
    const fullKey = JSON.stringify([
      flagKey, variant, allocation, rule, event.runtimeDefault === true, error,
      protectedKey, contextEntries, consent,
    ])
    const existing = this.#full.get(fullKey)
    if (existing) {
      observeEntry(existing, event.timestamp, consent)
      return
    }

    const perFlag = this.#perFlag.get(flagKey) ?? 0
    if (perFlag >= FLAG_EVALUATION_PER_FLAG_CAP) {
      this.#addDegraded(event, { flagKey, variant, allocation, rule, error })
      return
    }
    if (this.#perFlag.has(flagKey) || this.#full.size < FLAG_EVALUATION_GLOBAL_CAP) {
      this.#perFlag.set(flagKey, perFlag + 1)
    }
    if (this.#full.size >= FLAG_EVALUATION_GLOBAL_CAP) {
      this.#addDegraded(event, { flagKey, variant, allocation, rule, error })
      return
    }

    this.#full.set(fullKey, {
      flagKey,
      variant,
      allocation,
      rule,
      runtimeDefault: event.runtimeDefault === true,
      error,
      rawTargetingKey: targetingKey,
      // Repeated observations need validation and identity, but no new retained snapshot.
      attrs: snapshotFromEntries(contextEntries),
      consent,
      count: 1,
      first: event.timestamp,
      last: event.timestamp,
    })
  }

  /** @returns {AggregationResult} */
  take () {
    const result = { full: this.#full, degraded: this.#degraded }
    this.#full = new Map()
    this.#degraded = new Map()
    this.#perFlag = new Map()
    return result
  }

  clear () {
    const count = evaluationCount(this.#full) + evaluationCount(this.#degraded)
    this.#full = new Map()
    this.#degraded = new Map()
    this.#perFlag = new Map()
    return count
  }

  get size () {
    return this.#full.size + this.#degraded.size
  }

  /**
   * @param {FlagEvaluationEvent} event
   * @param {AggregationDimensions} dimensions
   */
  #addDegraded (event, dimensions) {
    recordDegraded('cardinality_cap')
    const key = JSON.stringify([
      dimensions.flagKey, dimensions.variant, dimensions.allocation, dimensions.rule,
      event.runtimeDefault === true, dimensions.error,
    ])
    const existing = this.#degraded.get(key)
    if (existing) {
      observeEntry(existing, event.timestamp, event.observeFullEvaluationData)
      return
    }
    if (this.#degraded.size >= FLAG_EVALUATION_DEGRADED_CAP) {
      recordDropped('degraded_cap')
      return
    }
    this.#degraded.set(key, {
      ...dimensions,
      runtimeDefault: event.runtimeDefault === true,
      consent: event.observeFullEvaluationData === true,
      count: 1,
      first: event.timestamp,
      last: event.timestamp,
    })
  }
}

module.exports = { FlagEvaluationAggregator }
