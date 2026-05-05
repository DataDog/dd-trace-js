'use strict'

const { encodeDeltaVarint, hashTargetingKey } = require('./encoding')

const MAX_SERIAL_IDS = 128
const MAX_SUBJECTS = 25
const MAX_DEFAULTS = 5
const MAX_DEFAULT_VALUE_LENGTH = 64
const CODED_DEFAULT_PREFIX = 'coded-default: '

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

    /** @type {Map<string, string>} flag key -> coded-default value */
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
      // Subject already tracked, just add the serial ID
      this._subjects.get(hashedKey).add(serialId)
      return true
    }

    if (this._subjects.size >= MAX_SUBJECTS) {
      return false
    }

    this._subjects.set(hashedKey, new Set([serialId]))
    return true
  }

  /**
   * Add a default fallback for a flag not found in UFC.
   *
   * @param {string} flagKey - The flag key
   * @param {*} defaultValue - The default value used
   * @returns {boolean} True if added, false if limit reached
   */
  addDefault (flagKey, defaultValue) {
    if (this._defaults.has(flagKey)) {
      return true // Already tracked
    }

    if (this._defaults.size >= MAX_DEFAULTS) {
      return false
    }

    // Format: "coded-default: <value>" truncated to 64 chars
    const valueStr = String(defaultValue)
    let codedValue = `${CODED_DEFAULT_PREFIX}${valueStr}`

    if (codedValue.length > MAX_DEFAULT_VALUE_LENGTH) {
      codedValue = codedValue.substring(0, MAX_DEFAULT_VALUE_LENGTH)
    }

    this._defaults.set(flagKey, codedValue)
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
   * @returns {Object} Object with ffe_flags_enc, ffe_subjects_enc, and ffe_defaults tags
   */
  toSpanTags () {
    const tags = {}

    // Encode serial IDs
    if (this._serialIds.size > 0) {
      tags.ffe_flags_enc = encodeDeltaVarint([...this._serialIds])
    }

    // Encode subjects (only if there are subjects with doLog=true)
    if (this._subjects.size > 0) {
      const subjectsObj = {}
      for (const [hashedKey, serialIds] of this._subjects) {
        subjectsObj[hashedKey] = encodeDeltaVarint([...serialIds])
      }
      tags.ffe_subjects_enc = JSON.stringify(subjectsObj)
    }

    // Encode defaults
    if (this._defaults.size > 0) {
      const defaultsObj = {}
      for (const [flagKey, codedValue] of this._defaults) {
        defaultsObj[flagKey] = codedValue
      }
      tags.ffe_defaults = JSON.stringify(defaultsObj)
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
  CODED_DEFAULT_PREFIX
}
