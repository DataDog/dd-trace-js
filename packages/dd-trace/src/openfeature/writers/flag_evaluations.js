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
 * Prunes the evaluation context to at most MAX_CONTEXT_FIELDS fields, sorting keys
 * deterministically and skipping string values longer than MAX_FIELD_LENGTH.
 * Mirrors flageval-worker MAX_EVALUATION_CONTEXT_FIELDS / MAX_FIELD_LENGTH exactly.
 *
 * @param {Record<string, unknown>} attrs - Raw context attributes
 * @returns {Record<string, unknown>}
 */
function pruneContext (attrs) {
  if (!attrs) return {}

  const keys = Object.keys(attrs).sort()
  const out = {}
  let count = 0

  for (const k of keys) {
    if (count >= MAX_CONTEXT_FIELDS) break
    const v = attrs[k]
    if (typeof v === 'string' && v.length > MAX_FIELD_LENGTH) continue
    out[k] = v
    count++
  }
  return out
}

/**
 * Builds the full-tier bucket key string (6 dimensions, comparable).
 *
 * @param {string} flagKey
 * @param {string} variant
 * @param {string} allocationKey
 * @param {string} reason
 * @param {string} targetingKey
 * @param {string} ctxKey
 * @returns {string}
 */
function makeFullKey (flagKey, variant, allocationKey, reason, targetingKey, ctxKey) {
  // NUL separator: safe because length-delimited ctxKey cannot contain NUL as a separator
  return `${flagKey}\0${variant}\0${allocationKey}\0${reason}\0${targetingKey}\0${ctxKey}`
}

/**
 * Builds the degraded-tier bucket key string (drops targetingKey + context).
 *
 * @param {string} flagKey
 * @param {string} variant
 * @param {string} allocationKey
 * @param {string} reason
 * @returns {string}
 */
function makeDegradedKey (flagKey, variant, allocationKey, reason) {
  return `${flagKey}\0${variant}\0${allocationKey}\0${reason}`
}

/**
 * @typedef {object} FlagEvalRawEvent
 * @property {string} flagKey
 * @property {string} variant - empty string means absent (runtime_default)
 * @property {string} reason
 * @property {string} allocationKey
 * @property {string} targetingKey
 * @property {number} evalTimeMs
 * @property {Record<string, unknown>} attrs
 */

/**
 * @typedef {object} FullEntry
 * @property {string} flagKey
 * @property {string} variant
 * @property {string} allocationKey
 * @property {string} reason
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
 * @property {string} reason
 * @property {number} count
 * @property {number} first
 * @property {number} last
 * @property {boolean} runtimeDefault
 */

/**
 * Sentinel object placed in _buffer to allow BaseFFEWriter.flush() to proceed.
 * The buffer is replaced by drain output in makePayload().
 */
const FLUSH_SENTINEL = Object.freeze({ _sentinel: true })

/**
 * FlagEvaluationsWriter extends BaseFFEWriter to aggregate EVP flagevaluation events
 * using two-tier (full → degraded → drop-counted) aggregation with a comparable
 * canonical-context key (no hash digest).
 *
 * The eval hot path (enqueue) does ONLY a cheap scalar capture + a bounded push to a
 * raw queue. All aggregation cost — prune, canonical key, two-tier map updates — runs
 * off the eval call stack on a microtask-scheduled drain (and on flush). OpenFeature
 * hooks run synchronously on the caller's evaluation, so charging aggregation to the
 * hook would charge it to the user's flag evaluation; this design keeps that off the
 * hot path, mirroring the dd-trace-go background-worker reference.
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

  /** @type {number} count of raw events dropped because the hand-off queue was full */
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
   * caller's evaluation. Does ONLY a bounded push to the raw queue + a microtask
   * schedule — NO prune, NO canonical-key, NO map aggregation (that runs in the
   * drain, off the eval call stack). On overflow, drop-and-count (observable) rather
   * than block the user's evaluation.
   *
   * @param {FlagEvalRawEvent} event
   * @returns {boolean} true if enqueued, false if dropped due to backpressure
   */
  enqueue (event) {
    if (this._rawQueue.length >= this._rawQueueCap) {
      this._droppedQueueOverflow++
      return false
    }

    this._rawQueue.push(event)

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
   * Aggregator. Drains every queued raw event through prune → canonical key →
   * two-tier aggregation. Runs off the eval hot path (microtask or flush), never
   * synchronously from enqueue().
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
   * Aggregates one raw event into the two-tier maps. Worker-path only.
   *
   * @private
   * @param {FlagEvalRawEvent} event
   */
  _aggregate (event) {
    const { flagKey, reason, evalTimeMs } = event
    const variant = event.variant ?? ''
    const allocationKey = event.allocationKey ?? ''
    const targetingKey = event.targetingKey ?? ''
    const attrs = event.attrs || {}

    const pruned = pruneContext(attrs)
    const ctxKey = canonicalContextKey(pruned)
    const isRuntimeDefault = variant === ''

    const fKey = makeFullKey(flagKey, variant, allocationKey, reason, targetingKey, ctxKey)

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
      this._addToDegraded(flagKey, variant, allocationKey, reason, evalTimeMs, isRuntimeDefault)
      return
    }

    // Increment per-flag attempt count
    this._perFlagFullCount.set(flagKey, perFlagCount + 1)

    // Check global cap
    if (this._globalCount >= this._globalCap) {
      this._addToDegraded(flagKey, variant, allocationKey, reason, evalTimeMs, isRuntimeDefault)
      return
    }

    // New full-tier bucket
    this._full.set(fKey, {
      flagKey,
      variant,
      allocationKey,
      reason,
      targetingKey,
      count: 1,
      first: evalTimeMs,
      last: evalTimeMs,
      runtimeDefault: isRuntimeDefault,
      contextAttrs: Object.keys(pruned).length > 0 ? pruned : null,
    })
    this._globalCount++

    // Place a sentinel in _buffer so BaseFFEWriter.flush() does not short-circuit
    if (this._buffer.length === 0) {
      this._buffer.push(FLUSH_SENTINEL)
      this._bufferSize = 1
    }
  }

  /**
   * Adds to the degraded tier. If degradedCap exceeded, increments droppedDegradedOverflow.
   *
   * @private
   * @param {string} flagKey
   * @param {string} variant
   * @param {string} allocationKey
   * @param {string} reason
   * @param {number} evalTimeMs
   * @param {boolean} isRuntimeDefault
   */
  _addToDegraded (flagKey, variant, allocationKey, reason, evalTimeMs, isRuntimeDefault) {
    const dKey = makeDegradedKey(flagKey, variant, allocationKey, reason)
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
      reason,
      count: 1,
      first: evalTimeMs,
      last: evalTimeMs,
      runtimeDefault: isRuntimeDefault,
    })

    // Place a sentinel in _buffer so BaseFFEWriter.flush() does not short-circuit
    if (this._buffer.length === 0) {
      this._buffer.push(FLUSH_SENTINEL)
      this._bufferSize = 1
    }
  }

  /**
   * Flushes aggregated buckets. Drains any pending raw events first so a flush never
   * races ahead of the microtask-scheduled drain and loses queued evaluations.
   */
  flush () {
    this._drainQueue()

    // Ensure drop counts are emitted (and reset) even when every event overflowed and
    // produced no bucket — without a sentinel BaseFFEWriter.flush() would short-circuit.
    if (this._buffer.length === 0 && (this._droppedQueueOverflow > 0 || this._droppedDegradedOverflow > 0)) {
      this._buffer.push(FLUSH_SENTINEL)
      this._bufferSize = 1
    }

    super.flush()
  }

  /**
   * Drains aggregation maps and returns the EVP flagevaluation payload.
   * Called by BaseFFEWriter.flush() with whatever is in _buffer (ignored here).
   *
   * @param {Array} _events - Ignored; aggregation maps are the canonical source
   * @returns {{ context: object, flagEvaluations: Array }}
   */
  makePayload (_events) {
    const nowMs = Date.now()
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

    if (this._droppedQueueOverflow > 0 || this._droppedDegradedOverflow > 0) {
      log.warn(
        '%s dropped evaluations (queue overflow: %d, degraded overflow: %d)',
        this.constructor.name, this._droppedQueueOverflow, this._droppedDegradedOverflow
      )
    }

    // Reset aggregation state
    this._full = new Map()
    this._degraded = new Map()
    this._perFlagFullCount = new Map()
    this._globalCount = 0
    this._droppedDegradedOverflow = 0
    this._droppedQueueOverflow = 0

    return { context: this._context, flagEvaluations }
  }
}

module.exports = FlagEvaluationsWriter
