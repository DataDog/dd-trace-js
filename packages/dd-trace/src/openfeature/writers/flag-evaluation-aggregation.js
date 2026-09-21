'use strict'

const { types: { isProxy } } = require('node:util')

const {
  FLAG_EVALUATION_DEGRADED_CAP,
  FLAG_EVALUATION_GLOBAL_CAP,
  FLAG_EVALUATION_PER_FLAG_CAP,
} = require('../constants/constants')
const { canonicalContextKey } = require('./flag-evaluation-context')
const { hashTargetingKey, normalizeTargetingKey, protectedErrorCode } = require('./flag-evaluation-pii')
const { recordDegraded, recordDropped } = require('./flag-evaluation-telemetry')

function optionalKey (value) {
  const key = normalizeTargetingKey(value)
  return key === undefined || key.length === 0 ? undefined : key
}

/**
 * Revalidate a hook-owned snapshot at the aggregation boundary.
 *
 * @param {unknown} attrs
 * @returns {Readonly<Record<string, string | number | boolean | null>> | undefined}
 */
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
  return hasAttrs ? Object.freeze(output) : undefined
}

/**
 * Merge one observation into an aggregation entry.
 *
 * @param {object} entry
 * @param {number} entry.count
 * @param {number} entry.first
 * @param {number} entry.last
 * @param {boolean} entry.consent
 * @param {number} timestamp
 * @param {unknown} consent
 */
function observeEntry (entry, timestamp, consent) {
  entry.count++
  entry.first = Math.min(entry.first, timestamp)
  entry.last = Math.max(entry.last, timestamp)
  entry.consent &&= consent === true
}

function evaluationCount (entries) {
  let count = 0
  for (const entry of entries.values()) count += entry.count
  return count
}

class FlagEvaluationAggregator {
  #full = new Map()
  #degraded = new Map()
  #perFlag = new Map()

  /** @param {object} event */
  add (event) {
    const flagKey = normalizeTargetingKey(event.flagKey)
    if (flagKey === undefined || !Number.isSafeInteger(event.timestamp)) {
      recordDropped('serialization_error')
      return
    }
    const consent = event.observeFullEvaluationData === true
    const targetingKey = normalizeTargetingKey(event.targetingKey)
    const attrs = consent ? safeAttrs(event.attrs) : undefined
    const contextKey = consent && attrs ? canonicalContextKey(attrs) : ''
    const protectedKey = consent ? targetingKey : hashTargetingKey(targetingKey)
    const error = protectedErrorCode(event.errorCode)
    const variant = optionalKey(event.variant)
    const allocation = optionalKey(event.allocationKey)
    const rule = optionalKey(event.targetingRuleKey)
    const fullKey = JSON.stringify([
      flagKey, variant, allocation, rule, event.runtimeDefault === true, error,
      protectedKey, contextKey, consent,
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
      attrs,
      consent,
      count: 1,
      first: event.timestamp,
      last: event.timestamp,
    })
  }

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

module.exports = { FlagEvaluationAggregator, observeEntry }
