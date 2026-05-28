'use strict'

const log = require('../log')

const { encodeDeltaVarint, hashTargetingKey } = require('./encoding')

const MAX_SERIAL_IDS = 128
const MAX_SUBJECTS = 10
const MAX_DEFAULTS = 5
const MAX_DEFAULT_VALUE_LENGTH = 64

/**
 * Manages feature flag enrichment state for a single root span.
 * Accumulates serial IDs, subjects, and defaults throughout the span's lifetime.
 */
class SpanEnrichmentState {
  constructor () {
    /** @type {Set<number>} */
    this._serialIds = new Set()

    /** @type {Map<string, Set<number>>} hashed targeting key -> serial IDs */
    this._subjects = new Map()

    /** @type {Map<string, string>} flag key -> runtime default value */
    this._defaults = new Map()
  }

  /**
   * Add a serial ID from a flag evaluation.
   *
   * @param {number} serialId - The serial ID to add
   * @returns {boolean} True if added, false if limit reached
   */
  addSerialId (serialId) {
    if (this._serialIds.size >= MAX_SERIAL_IDS) {
      log.debug('SpanEnrichment: MAX_SERIAL_IDS limit (%d) reached, dropping serialId %d', MAX_SERIAL_IDS, serialId)
      return false
    }
    this._serialIds.add(serialId)
    return true
  }

  /**
   * Add a subject (targeting key) with its associated serial ID.
   * Only called when doLog=true.
   *
   * @param {string} targetingKey - The targeting key (will be hashed)
   * @param {number} serialId - The serial ID associated with this evaluation
   * @returns {boolean} True if added, false if limit reached
   */
  addSubject (targetingKey, serialId) {
    const hashedKey = hashTargetingKey(targetingKey)

    if (this._subjects.has(hashedKey)) {
      this._subjects.get(hashedKey).add(serialId)
      return true
    }

    if (this._subjects.size >= MAX_SUBJECTS) {
      log.debug('SpanEnrichment: MAX_SUBJECTS limit (%d) reached, dropping subject', MAX_SUBJECTS)
      return false
    }

    this._subjects.set(hashedKey, new Set([serialId]))
    return true
  }

  /**
   * Add a default fallback for a flag not found in UFC.
   *
   * @param {string} flagKey - The flag key
   * @param {boolean|string|number|object} defaultValue - The default value used
   * @returns {boolean} True if added, false if limit reached
   */
  addDefault (flagKey, defaultValue) {
    if (this._defaults.has(flagKey)) {
      return true
    }

    if (this._defaults.size >= MAX_DEFAULTS) {
      log.debug('SpanEnrichment: MAX_DEFAULTS limit (%d) reached, dropping flag %s', MAX_DEFAULTS, flagKey)
      return false
    }

    let valueStr = String(defaultValue)

    if (valueStr.length > MAX_DEFAULT_VALUE_LENGTH) {
      valueStr = valueStr.slice(0, MAX_DEFAULT_VALUE_LENGTH)
    }

    this._defaults.set(flagKey, valueStr)
    return true
  }

  /**
   * Check if there is any enrichment data to add to the span.
   *
   * @returns {boolean} True if there is data to add
   */
  hasData () {
    return this._serialIds.size > 0 || this._defaults.size > 0
  }

  /**
   * Convert accumulated state to span tags.
   *
   * @returns {object} Object with ffe_flags_enc, ffe_subjects_enc, and ffe_runtime_defaults tags
   */
  toSpanTags () {
    const tags = {}

    if (this._serialIds.size > 0) {
      tags.ffe_flags_enc = encodeDeltaVarint(this._serialIds)
    }

    if (this._subjects.size > 0) {
      const subjectsObj = Object.fromEntries(
        [...this._subjects].map(([key, ids]) => [key, encodeDeltaVarint(ids)])
      )
      tags.ffe_subjects_enc = JSON.stringify(subjectsObj)
    }

    if (this._defaults.size > 0) {
      tags.ffe_runtime_defaults = JSON.stringify(Object.fromEntries(this._defaults))
    }

    return tags
  }
}

module.exports = {
  SpanEnrichmentState,
  MAX_SERIAL_IDS,
  MAX_SUBJECTS,
  MAX_DEFAULTS,
  MAX_DEFAULT_VALUE_LENGTH,
}
