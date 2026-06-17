'use strict'

const {
  FLAGEVALUATIONS_ENDPOINT,
  EVP_PROXY_AGENT_BASE_PATH,
  EVP_SUBDOMAIN_HEADER_NAME,
  EVP_SUBDOMAIN_VALUE,
  EVP_PAYLOAD_SIZE_LIMIT,
  EVP_EVENT_SIZE_LIMIT,
} = require('../constants/constants')
const log = require('../../log')
const BaseFFEWriter = require('./base')

// Aggregation caps
const GLOBAL_CAP = 131_072
const PER_FLAG_CAP = 10_000
const DEGRADED_CAP = 32_768

// Bounded hand-off queue between the eval hot path (enqueue) and the aggregator (drain).
// On overflow we drop-and-count rather than block the user's evaluation.
const RAW_QUEUE_CAP = 4096

// Context pruning bounds — mirrors flageval-worker limits
const MAX_CONTEXT_FIELDS = 256
const MAX_FIELD_LENGTH = 256

// Type-tag bytes for canonical context key encoding.
// Distinct per JS type so that, e.g., int 1 and string "1" cannot alias.
const TAG_STRING = 's'
const TAG_BOOL = 'b'
const TAG_NUMBER = 'n' // all JS numbers (float64 under the hood)
const TAG_NULL = '0'
const TAG_OTHER = 'o'

/**
 * Encodes a length-delimited field using an 8-byte big-endian prefix.
 * Returns a binary string so that field boundaries are unambiguous.
 *
 * @param {Buffer} bytes
 * @returns {string}
 */
function appendLengthDelimited (bytes) {
  const lenBuf = Buffer.alloc(8)
  lenBuf.writeBigUInt64BE(BigInt(bytes.length), 0)
  return lenBuf.toString('binary') + bytes.toString('binary')
}

/**
 * Encodes a single key+value pair into the canonical buffer string.
 *
 * @param {string} key
 * @param {unknown} value
 * @returns {string}
 */
function encodeField (key, value) {
  const keyEncoded = appendLengthDelimited(Buffer.from(key, 'utf8'))

  let tag
  let valStr
  if (typeof value === 'string') {
    tag = TAG_STRING
    valStr = value
  } else if (typeof value === 'boolean') {
    tag = TAG_BOOL
    valStr = value ? 'true' : 'false'
  } else if (typeof value === 'number') {
    tag = TAG_NUMBER
    valStr = String(value)
  } else if (value === null) {
    tag = TAG_NULL
    valStr = ''
  } else {
    tag = TAG_OTHER
    valStr = String(value)
  }

  const valEncoded = appendLengthDelimited(Buffer.from(valStr, 'utf8'))
  return keyEncoded + tag + valEncoded
}

/**
 * Builds the canonical, comparable context key for a pruned context map.
 * Keys are sorted for determinism; each field is type-tagged and length-delimited
 * so distinct types and values always produce distinct keys (no collision).
 * Uses exact comparable string, not a hash digest (no collision).
 *
 * @param {Record<string, unknown>} attrs - Pruned context attributes
 * @returns {string}
 */
function canonicalContextKey (attrs) {
  const keys = Object.keys(attrs)
  if (keys.length === 0) return ''

  keys.sort()
  let out = ''
  for (const k of keys) {
    out += encodeField(k, attrs[k])
  }
  return out
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {string} prefix
 * @param {unknown} value
 * @param {Record<string, unknown>} out
 * @returns {void}
 */
function flattenValue (prefix, value, out) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    return
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      flattenValue(`${prefix}.${i}`, value[i], out)
    }
    return
  }

  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      flattenValue(`${prefix}.${key}`, value[key], out)
    }
    return
  }

  out[prefix] = value
}

/**
 * Flattens nested context attributes into dot-notation keys and removes targetingKey,
 * which is emitted separately as targeting_key.
 *
 * @param {Record<string, unknown>} attrs
 * @returns {Record<string, unknown>}
 */
function flattenContext (attrs) {
  if (!attrs) return {}

  const out = {}
  for (const key of Object.keys(attrs)) {
    if (key === 'targetingKey') continue
    flattenValue(key, attrs[key], out)
  }
  return out
}

/**
 * Flattens and prunes the evaluation context to at most MAX_CONTEXT_FIELDS fields,
 * sorting keys deterministically and skipping string values longer than MAX_FIELD_LENGTH.
 * Mirrors flageval-worker MAX_EVALUATION_CONTEXT_FIELDS / MAX_FIELD_LENGTH exactly.
 *
 * @param {Record<string, unknown>} attrs - Raw context attributes
 * @returns {Record<string, unknown>}
 */
function pruneContext (attrs) {
  const flat = flattenContext(attrs)
  if (Object.keys(flat).length === 0) return {}

  const keys = Object.keys(flat).sort()
  const out = {}
  let count = 0

  for (const k of keys) {
    if (count >= MAX_CONTEXT_FIELDS) break
    const v = flat[k]
    if (typeof v === 'string' && v.length > MAX_FIELD_LENGTH) continue
    out[k] = v
    count++
  }
  return out
}

/**
 * Builds the full-tier bucket key string from schema-visible dimensions only.
 *
 * @param {string} flagKey
 * @param {string} variant
 * @param {string} allocationKey
 * @param {string} targetingKey
 * @param {string} ctxKey
 * @returns {string}
 */
function makeFullKey (flagKey, variant, allocationKey, targetingKey, ctxKey) {
  // NUL separator: safe because length-delimited ctxKey cannot contain NUL as a separator
  return `${flagKey}\0${variant}\0${allocationKey}\0${targetingKey}\0${ctxKey}`
}

/**
 * Builds the degraded-tier bucket key string (drops targetingKey + context).
 *
 * @param {string} flagKey
 * @param {string} variant
 * @param {string} allocationKey
 * @returns {string}
 */
function makeDegradedKey (flagKey, variant, allocationKey) {
  return `${flagKey}\0${variant}\0${allocationKey}`
}

/**
 * @typedef {object} FlagEvalRawEvent
 * @property {string} flagKey
 * @property {string} variant - empty string means absent (runtime_default)
 * @property {string} allocationKey
 * @property {string} targetingKey
 * @property {number} evalTimeMs
 * @property {Record<string, unknown>} attrs - Flattened and pruned context attributes
 */

/**
 * @typedef {object} FullEntry
 * @property {string} flagKey
 * @property {string} variant
 * @property {string} allocationKey
 * @property {string} targetingKey
 * @property {number} count
 * @property {number} first
 * @property {number} last
 * @property {boolean} runtimeDefault
 * @property {Record<string, unknown> | null} contextAttrs
 */

/**
 * @typedef {object} DegradedEntry
 * @property {string} flagKey
 * @property {string} variant
 * @property {string} allocationKey
 * @property {number} count
 * @property {number} first
 * @property {number} last
 * @property {boolean} runtimeDefault
 */

/**
 * FlagEvaluationsWriter extends BaseFFEWriter to aggregate EVP flagevaluation events
 * using two-tier (full → degraded → drop-counted) aggregation with a comparable
 * canonical-context key (no hash digest).
 *
 * The eval hot path (enqueue) captures scalars, makes a bounded context snapshot, and
 * pushes to a bounded queue. Aggregation cost — canonical key and two-tier map updates —
 * runs off the eval call stack on a microtask-scheduled drain (and on flush).
 *
 * Aggregation caps: globalCap=131072 / perFlagCap=10000 / degradedCap=32768
 * Context bounds: 256 fields / 256 chars (pruned before keying).
 * Killswitch: DD_FLAGGING_EVALUATION_COUNTS_ENABLED (checked by the provider).
 */
class FlagEvaluationsWriter extends BaseFFEWriter {
  /** @type {Record<string, unknown>} */
  _context

  /** @type {Array<FlagEvalRawEvent>} bounded hand-off queue, drained by the aggregator */
  _rawQueue

  /** @type {boolean} whether a drain is already scheduled (microtask coalescing) */
  _drainScheduled

  /** @type {(() => void) | undefined} cached drain callback to avoid per-enqueue closure allocation */
  _boundDrain

  /** @type {number} count of event snapshots dropped because the hand-off queue was full */
  _droppedQueueOverflow

  /** @type {Map<string, FullEntry>} */
  _full

  /** @type {Map<string, DegradedEntry>} */
  _degraded

  /** @type {Map<string, number>} per-flag count of full-tier entries created */
  _perFlagFullCount

  /** @type {number} */
  _globalCount

  /** @type {number} count of evaluations dropped because the degraded tier was full */
  _droppedDegradedOverflow

  // Hand-off queue cap — overridable in tests
  _rawQueueCap = RAW_QUEUE_CAP

  // Aggregation caps — overridable in tests
  _globalCap = GLOBAL_CAP
  _perFlagCap = PER_FLAG_CAP
  _degradedCap = DEGRADED_CAP

  /**
   * @param {import('../../config')} config - Tracer configuration object
   */
  constructor (config) {
    const basePath = EVP_PROXY_AGENT_BASE_PATH.replace(/\/+$/, '')
    const endpoint = FLAGEVALUATIONS_ENDPOINT.replace(/^\/+/, '')
    const fullEndpoint = `${basePath}/${endpoint}`

    super({
      config,
      endpoint: fullEndpoint,
      interval: 10_000,
      payloadSizeLimit: EVP_PAYLOAD_SIZE_LIMIT,
      eventSizeLimit: EVP_EVENT_SIZE_LIMIT,
      headers: {
        [EVP_SUBDOMAIN_HEADER_NAME]: EVP_SUBDOMAIN_VALUE,
      },
    })

    const context = { service: config.service }
    if (config.version !== undefined) context.version = config.version
    if (config.env !== undefined) context.env = config.env
    this._context = context

    this._rawQueue = []
    this._drainScheduled = false
    this._droppedQueueOverflow = 0

    this._full = new Map()
    this._degraded = new Map()
    this._perFlagFullCount = new Map()
    this._globalCount = 0
    this._droppedDegradedOverflow = 0
  }

  /**
   * Hot-path capture. Called synchronously from the OpenFeature Finally hook on the
   * caller's evaluation. Makes a bounded context snapshot before buffering, then
   * schedules the aggregate drain — NO canonical-key or map aggregation runs here.
   * On overflow, drop-and-count (observable) rather than block the user's evaluation.
   *
   * @param {FlagEvalRawEvent} event
   * @returns {boolean} true if enqueued, false if dropped due to backpressure
   */
  enqueue (event) {
    if (this._rawQueue.length >= this._rawQueueCap) {
      this._droppedQueueOverflow++
      return false
    }

    this._rawQueue.push({
      flagKey: event.flagKey,
      variant: event.variant ?? '',
      allocationKey: event.allocationKey ?? '',
      targetingKey: event.targetingKey ?? '',
      evalTimeMs: event.evalTimeMs,
      attrs: pruneContext(event.attrs || {}),
    })

    if (!this._drainScheduled) {
      this._drainScheduled = true
      if (this._boundDrain === undefined) {
        this._boundDrain = () => this._drainQueue()
      }
      setImmediate(this._boundDrain)
    }
    return true
  }

  /**
   * Aggregator. Drains every queued bounded event through canonical key → two-tier
   * aggregation. Runs off the eval hot path (microtask or flush), never synchronously
   * from enqueue().
   */
  _drainQueue () {
    this._drainScheduled = false
    const queue = this._rawQueue
    if (queue.length === 0) return
    this._rawQueue = []

    for (const event of queue) {
      this._aggregate(event)
    }
  }

  /**
   * Aggregates one bounded event snapshot into the two-tier maps. Worker-path only.
   *
   * @private
   * @param {FlagEvalRawEvent} event
   */
  _aggregate (event) {
    const { flagKey, evalTimeMs } = event
    const variant = event.variant ?? ''
    const allocationKey = event.allocationKey ?? ''
    const targetingKey = event.targetingKey ?? ''
    const attrs = event.attrs || {}

    const ctxKey = canonicalContextKey(attrs)
    const isRuntimeDefault = variant === ''

    const fKey = makeFullKey(flagKey, variant, allocationKey, targetingKey, ctxKey)

    // Fast path: existing full-tier bucket
    const existing = this._full.get(fKey)
    if (existing) {
      existing.count++
      if (evalTimeMs < existing.first) existing.first = evalTimeMs
      if (evalTimeMs > existing.last) existing.last = evalTimeMs
      return
    }

    // Check per-flag cap
    const perFlagCount = this._perFlagFullCount.get(flagKey) ?? 0
    if (perFlagCount >= this._perFlagCap) {
      this._addToDegraded(flagKey, variant, allocationKey, evalTimeMs, isRuntimeDefault)
      return
    }

    // Increment per-flag attempt count
    this._perFlagFullCount.set(flagKey, perFlagCount + 1)

    // Check global cap
    if (this._globalCount >= this._globalCap) {
      this._addToDegraded(flagKey, variant, allocationKey, evalTimeMs, isRuntimeDefault)
      return
    }

    // New full-tier bucket
    this._full.set(fKey, {
      flagKey,
      variant,
      allocationKey,
      targetingKey,
      count: 1,
      first: evalTimeMs,
      last: evalTimeMs,
      runtimeDefault: isRuntimeDefault,
      contextAttrs: Object.keys(attrs).length > 0 ? attrs : null,
    })
    this._globalCount++
  }

  /**
   * Adds to the degraded tier. If degradedCap exceeded, increments droppedDegradedOverflow.
   *
   * @private
   * @param {string} flagKey
   * @param {string} variant
   * @param {string} allocationKey
   * @param {number} evalTimeMs
   * @param {boolean} isRuntimeDefault
   */
  _addToDegraded (flagKey, variant, allocationKey, evalTimeMs, isRuntimeDefault) {
    const dKey = makeDegradedKey(flagKey, variant, allocationKey)
    const existing = this._degraded.get(dKey)
    if (existing) {
      existing.count++
      if (evalTimeMs < existing.first) existing.first = evalTimeMs
      if (evalTimeMs > existing.last) existing.last = evalTimeMs
      return
    }

    // New degraded bucket — check cap
    if (this._degraded.size >= this._degradedCap) {
      this._droppedDegradedOverflow++
      return
    }

    this._degraded.set(dKey, {
      flagKey,
      variant,
      allocationKey,
      count: 1,
      first: evalTimeMs,
      last: evalTimeMs,
      runtimeDefault: isRuntimeDefault,
    })
  }

  /**
   * Flushes aggregated buckets. Drains any pending event snapshots first so a flush never
   * races ahead of the microtask-scheduled drain and loses queued evaluations.
   */
  flush () {
    this._drainQueue()

    const nowMs = Date.now()
    const flagEvaluations = this._drainFlagEvaluations(nowMs)
    const droppedQueueOverflow = this._droppedQueueOverflow
    const droppedDegradedOverflow = this._droppedDegradedOverflow

    this._resetAggregationState()

    if (droppedQueueOverflow > 0 || droppedDegradedOverflow > 0) {
      log.warn(
        '%s dropped evaluations (queue overflow: %d, degraded overflow: %d)',
        this.constructor.name, droppedQueueOverflow, droppedDegradedOverflow
      )
    }

    this._flushPayloadBatches(flagEvaluations)
  }

  /**
   * @private
   * @param {number} nowMs
   * @returns {Array<object>}
   */
  _drainFlagEvaluations (nowMs) {
    const flagEvaluations = []

    // Full tier: all optional fields (variant, allocation, targeting_key, context)
    for (const entry of this._full.values()) {
      const ev = {
        timestamp: nowMs,
        flag: { key: entry.flagKey },
        first_evaluation: entry.first,
        last_evaluation: entry.last,
        evaluation_count: entry.count,
      }

      if (entry.runtimeDefault) ev.runtime_default_used = true
      if (entry.targetingKey) ev.targeting_key = entry.targetingKey
      if (entry.variant) ev.variant = { key: entry.variant }
      if (entry.allocationKey) ev.allocation = { key: entry.allocationKey }
      if (entry.contextAttrs && Object.keys(entry.contextAttrs).length > 0) {
        ev.context = { evaluation: entry.contextAttrs }
      }

      flagEvaluations.push(ev)
    }

    // Degraded tier: required fields + variant + allocation; NO targeting_key, NO context
    for (const entry of this._degraded.values()) {
      const ev = {
        timestamp: nowMs,
        flag: { key: entry.flagKey },
        first_evaluation: entry.first,
        last_evaluation: entry.last,
        evaluation_count: entry.count,
      }

      if (entry.runtimeDefault) ev.runtime_default_used = true
      if (entry.variant) ev.variant = { key: entry.variant }
      if (entry.allocationKey) ev.allocation = { key: entry.allocationKey }

      flagEvaluations.push(ev)
    }

    return flagEvaluations
  }

  /**
   * @private
   * @param {Array<object>} flagEvaluations
   * @returns {void}
   */
  _flushPayloadBatches (flagEvaluations) {
    const payloadPrefix = `{"context":${this._encode(this._context)},"flagEvaluations":[`
    const payloadSuffix = ']}'
    const basePayloadSizeBytes = Buffer.byteLength(payloadPrefix) + Buffer.byteLength(payloadSuffix)

    let batch = []
    let batchSizeBytes = basePayloadSizeBytes

    for (const event of flagEvaluations) {
      const encodedEvent = this._encode(event)
      const eventSizeBytes = Buffer.byteLength(encodedEvent)
      if (this._eventSizeLimit && eventSizeBytes > this._eventSizeLimit) {
        log.warn('%s event size %d bytes exceeds limit %d, dropping event',
          this.constructor.name, eventSizeBytes, this._eventSizeLimit)
        this._droppedEvents++
        continue
      }

      const separatorBytes = batch.length > 0 ? 1 : 0
      const candidateSizeBytes = batchSizeBytes + separatorBytes + eventSizeBytes

      if (this._payloadSizeLimit && candidateSizeBytes > this._payloadSizeLimit && batch.length > 0) {
        this._sendPayload(payloadPrefix + batch.join(',') + payloadSuffix, batch.length)
        batch = []
        batchSizeBytes = basePayloadSizeBytes

        const singleSizeBytes = batchSizeBytes + eventSizeBytes
        if (this._payloadSizeLimit && singleSizeBytes > this._payloadSizeLimit) {
          log.warn('%s payload size %d bytes exceeds limit %d, dropping event',
            this.constructor.name, singleSizeBytes, this._payloadSizeLimit)
          this._droppedEvents++
        } else {
          batch = [encodedEvent]
          batchSizeBytes = singleSizeBytes
        }
        continue
      }

      if (this._payloadSizeLimit && candidateSizeBytes > this._payloadSizeLimit) {
        log.warn('%s payload size %d bytes exceeds limit %d, dropping event',
          this.constructor.name, candidateSizeBytes, this._payloadSizeLimit)
        this._droppedEvents++
        continue
      }

      batch.push(encodedEvent)
      batchSizeBytes = candidateSizeBytes
    }

    if (batch.length > 0) {
      this._sendPayload(payloadPrefix + batch.join(',') + payloadSuffix, batch.length)
    }
  }

  /**
   * Returns the EVP flagevaluation payload for a batch of already-drained events.
   *
   * @param {Array<object>} events - Aggregated event batch to send
   * @returns {{ context: object, flagEvaluations: Array }}
   */
  makePayload (events) {
    return { context: this._context, flagEvaluations: events }
  }

  _resetAggregationState () {
    this._full = new Map()
    this._degraded = new Map()
    this._perFlagFullCount = new Map()
    this._globalCount = 0
    this._droppedDegradedOverflow = 0
    this._droppedQueueOverflow = 0
  }
}

module.exports = FlagEvaluationsWriter
