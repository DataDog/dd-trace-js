'use strict'

const { AgentEncoder } = require('./0.4')
const { normalizeSpan } = require('./tags-processors')

const CROSS_PAYLOAD_CACHE_LIMIT = 256
const CROSS_PAYLOAD_CANDIDATE_LIMIT = 512
const CROSS_PAYLOAD_LEARNING_PAYLOAD_LIMIT = 8
const CROSS_PAYLOAD_MISS_LIMIT = 32
const CROSS_PAYLOAD_STRING_LIMIT = 256
const crossPayloadStates = new WeakMap()

class CrossPayloadAgentEncoder extends AgentEncoder {
  #disableCrossPayloadCache

  /**
   * @param {{ flush: () => void }} writer
   * @param {() => void} disableCrossPayloadCache
   */
  constructor (writer, disableCrossPayloadCache) {
    super(writer)
    this.#disableCrossPayloadCache = disableCrossPayloadCache
    crossPayloadStates.set(this, createCrossPayloadState())
  }

  /**
   * @param {object[]} trace
   */
  encode (trace) {
    const crossPayloadState = crossPayloadStates.get(this)
    if (crossPayloadState !== undefined &&
      crossPayloadState.learningPayloadCount < CROSS_PAYLOAD_LEARNING_PAYLOAD_LIMIT) {
      for (const span of trace) {
        normalizeSpan(span)
        if (span.type) markPayloadString(crossPayloadState, span.type)
        markPayloadString(crossPayloadState, span.name)
        markPayloadString(crossPayloadState, span.resource)
        markPayloadString(crossPayloadState, span.service)
        if (span.meta) {
          markMapKeys(crossPayloadState, span.meta)
        }
        if (span.metrics) {
          markMapKeys(crossPayloadState, span.metrics)
        }
      }
    }
    super.encode(trace)
  }

  /**
   * @param {string} value
   * @returns {Buffer}
   */
  _cacheString (value) {
    const crossPayloadState = crossPayloadStates.get(this)
    if (crossPayloadState === undefined || value.length === 0 || value.length > CROSS_PAYLOAD_STRING_LIMIT) {
      return AgentEncoder.prototype._cacheString.call(this, value)
    }

    const learning = crossPayloadState.learningPayloadCount < CROSS_PAYLOAD_LEARNING_PAYLOAD_LIMIT
    const retainedEntry = crossPayloadState.stringMap?.[value]
    if (retainedEntry !== undefined) {
      if (!learning && crossPayloadState.hitCount < CROSS_PAYLOAD_MISS_LIMIT) {
        crossPayloadState.hitCount++
      }
      return retainedEntry
    }
    if (!learning && crossPayloadState.missCount < CROSS_PAYLOAD_MISS_LIMIT) {
      crossPayloadState.missCount++
    }
    if (!learning || crossPayloadState.payloadStableStrings?.[value] !== true) {
      return AgentEncoder.prototype._cacheString.call(this, value)
    }

    let entry = AgentEncoder.prototype._cacheString.call(this, value)
    if (entry.length > CROSS_PAYLOAD_STRING_LIMIT) return entry

    const previousPayloadStrings = crossPayloadState.previousPayloadStrings
    if (previousPayloadStrings?.[value] !== undefined &&
      crossPayloadState.stringCount < CROSS_PAYLOAD_CACHE_LIMIT) {
      entry = Buffer.from(entry)
      crossPayloadState.stringMap ??= Object.create(null)
      crossPayloadState.stringMap[value] = entry
      crossPayloadState.stringCount++
    }
    return entry
  }

  /** @returns {Buffer} */
  makePayload () {
    this.#prepareReset()
    return super.makePayload()
  }

  /** @returns {void} */
  reset () {
    this.#prepareReset()
    super.reset()
  }

  /** @returns {void} */
  #prepareReset () {
    const crossPayloadState = crossPayloadStates.get(this)
    if (crossPayloadState !== undefined && !prepareCrossPayloadReset(crossPayloadState)) {
      crossPayloadStates.delete(this)
      this.#disableCrossPayloadCache()
    }
  }
}

/**
 * @param {{ flush: () => void }} writer
 * @param {() => void} disableCrossPayloadCache
 * @returns {AgentEncoder}
 */
function createAgentEncoder (writer, disableCrossPayloadCache) {
  return new CrossPayloadAgentEncoder(writer, disableCrossPayloadCache)
}

function createCrossPayloadState () {
  return {
    hitCount: 0,
    learningPayloadCount: 0,
    lowUseCount: 0,
    missCount: 0,
    payloadStableStringCount: 0,
    payloadStableStrings: undefined,
    previousPayloadStrings: undefined,
    stringCount: 0,
    stringMap: undefined,
  }
}

/**
 * @param {ReturnType<typeof createCrossPayloadState>} crossPayloadState
 * @param {string} value
 */
function markPayloadString (crossPayloadState, value) {
  if (value.length === 0 ||
    value.length > CROSS_PAYLOAD_STRING_LIMIT ||
    crossPayloadState.payloadStableStringCount >= CROSS_PAYLOAD_CANDIDATE_LIMIT ||
    crossPayloadState.payloadStableStrings?.[value] !== undefined) {
    return
  }
  crossPayloadState.payloadStableStrings ??= Object.create(null)
  crossPayloadState.payloadStableStrings[value] = true
  crossPayloadState.payloadStableStringCount++
}

/**
 * @param {ReturnType<typeof createCrossPayloadState>} crossPayloadState
 * @param {Record<string, unknown>} value
 */
function markMapKeys (crossPayloadState, value) {
  for (const key of Object.keys(value)) {
    const entryValue = value[key]
    if (typeof entryValue === 'string' || typeof entryValue === 'number') {
      markPayloadString(crossPayloadState, key)
    }
  }
}

/**
 * @param {ReturnType<typeof createCrossPayloadState>} crossPayloadState
 * @returns {boolean}
 */
function prepareCrossPayloadReset (crossPayloadState) {
  const learning = crossPayloadState.learningPayloadCount < CROSS_PAYLOAD_LEARNING_PAYLOAD_LIMIT
  const lowUse = !learning && crossPayloadState.hitCount < crossPayloadState.missCount
  if (lowUse) {
    crossPayloadState.lowUseCount++
  } else if (!learning && crossPayloadState.hitCount > 0) {
    crossPayloadState.lowUseCount = 0
  }

  if (lowUse) {
    if (crossPayloadState.lowUseCount >= 2) return false
    crossPayloadState.learningPayloadCount = 0
    crossPayloadState.stringCount = 0
    crossPayloadState.stringMap = undefined
    crossPayloadState.payloadStableStrings = undefined
    crossPayloadState.payloadStableStringCount = 0
    crossPayloadState.previousPayloadStrings = undefined
    crossPayloadState.hitCount = 0
    crossPayloadState.missCount = 0
    return true
  }

  if (learning) {
    crossPayloadState.learningPayloadCount++
    if (crossPayloadState.learningPayloadCount < CROSS_PAYLOAD_LEARNING_PAYLOAD_LIMIT) {
      crossPayloadState.previousPayloadStrings = crossPayloadState.payloadStableStrings
    } else {
      crossPayloadState.previousPayloadStrings = undefined
      if (crossPayloadState.stringMap === undefined) return false
    }
  }
  crossPayloadState.payloadStableStrings = undefined
  crossPayloadState.payloadStableStringCount = 0
  crossPayloadState.hitCount = 0
  crossPayloadState.missCount = 0
  return true
}

module.exports = { createAgentEncoder }
