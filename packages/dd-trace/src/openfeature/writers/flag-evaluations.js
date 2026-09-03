'use strict'

const {
  FLAGEVALUATIONS_ENDPOINT,
  EVP_PAYLOAD_SIZE_LIMIT,
  EVP_EVENT_SIZE_LIMIT,
} = require('../constants/constants')
const {
  EVP_EVENT_PLATFORM_SUBDOMAIN,
  EVP_PROXY_PATH_V2,
  EVP_SUBDOMAIN_HEADER_NAME,
} = require('../../evp_proxy/constants')
const { joinEVPProxyPath } = require('../../evp_proxy/path')
const log = require('../../log')
const telemetryMetrics = require('../../telemetry/metrics')
const BaseFFEWriter = require('./base')

const EVAL_SCALE_TARGET_FLAGS = 2500
const EVAL_SCALE_FULL_BUCKETS_PER_FLAG = 50
const EVAL_SCALE_USERS_PER_FLAG = 1000
const EVAL_SCALE_PER_FLAG_HEADROOM_MULTIPLIER = 10
const EVAL_SCALE_DEGRADED_BUCKETS_PER_FLAG = 10

// Aggregation caps
const GLOBAL_CAP = 131_072
const PER_FLAG_CAP = EVAL_SCALE_PER_FLAG_HEADROOM_MULTIPLIER * EVAL_SCALE_USERS_PER_FLAG
const DEGRADED_CAP = 32_768
const EVAL_SCALE_FULL_BUCKET_TARGET = EVAL_SCALE_TARGET_FLAGS * EVAL_SCALE_FULL_BUCKETS_PER_FLAG
const EVAL_SCALE_DEGRADED_BUCKET_TARGET = EVAL_SCALE_TARGET_FLAGS * EVAL_SCALE_DEGRADED_BUCKETS_PER_FLAG

// Bounded hand-off queue between the eval hot path (enqueue) and the aggregator (drain).
// On overflow we drop-and-count rather than block the user's evaluation.
const RAW_QUEUE_CAP = 4096

const FLAG_EVALUATION_DROPPED_METRIC = 'flagevaluation.rows.dropped'
const FLAG_EVALUATION_DEGRADED_METRIC = 'flagevaluation.rows.degraded'
const FLAG_EVALUATION_SPLITS_METRIC = 'flagevaluation.payload.splits'

const DROP_REASON_QUEUE_OVERFLOW = 'queue_overflow'
const DROP_REASON_DEGRADED_CAP = 'degraded_cap'
const DROP_REASON_PAYLOAD_LIMIT = 'payload_limit'
const DEGRADED_REASON_CARDINALITY_CAP = 'cardinality_cap'
const DEGRADED_REASON_PAYLOAD_LIMIT = 'payload_limit'

const tracerMetrics = telemetryMetrics.manager.namespace('tracers')

// Context pruning bounds — mirrors flageval-worker limits
const MAX_CONTEXT_FIELDS = 256
const MAX_FIELD_LENGTH = 256

// Depth cap for context flattening. Mirrors Java DDEvaluator.MAX_SNAPSHOT_DEPTH.
// Guards against exotic inputs beyond the cycle-set guarantee. Values at or beyond
// this depth are dropped rather than emitted, matching the cycle-truncation policy.
const MAX_CONTEXT_DEPTH = 32

/**
 * @typedef {object} FlagEvaluationRoute
 * @property {URL} url - Route base URL
 * @property {string} basePath - EVP base path
 * @property {object} [headers] - Route-specific headers
 * @property {import('node:https').Agent} [agent] - Optional HTTPS proxy agent
 * @property {FlagEvaluationRoute} [fallback] - Optional direct fallback route
 */

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
 * Each field is type-tagged and length-delimited so distinct types and values
 * always produce distinct keys (no collision). Uses exact comparable string,
 * not a hash digest (no collision).
 *
 * Contract: `attrs` must arrive with keys in ascending order — `pruneContext`
 * guarantees this. Iterating Object.keys(attrs) here therefore yields sorted
 * order without an extra sort pass.
 *
 * @param {Record<string, unknown>} attrs - Pruned, sort-ordered context attributes
 * @returns {string}
 */
function canonicalContextKey (attrs) {
  if (!attrs) return ''
  let out = ''
  for (const k of Object.keys(attrs)) {
    out += encodeField(k, attrs[k])
  }
  return out
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject (value) {
  // Date (and other scalar-like objects OpenFeature permits as EvaluationContextValue)
  // must be treated as leaves, not traversed: `Object.keys(new Date())` is empty, so
  // descending into a Date would silently drop it. Dates are serialized to ISO strings
  // in the flatten leaf branch below.
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    !(value instanceof Date)
}

/**
 * Assigns `value` to `obj[key]` as an own enumerable data property. An own `__proto__`
 * key (e.g. from a JSON-parsed context) would otherwise invoke the legacy prototype
 * setter on an ordinary `{}` and be silently dropped, so the special key uses
 * `Object.defineProperty` to create a real data property. Dotted keys like
 * `user.__proto__` are not the special key and are safe with plain assignment.
 *
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @param {unknown} value
 * @returns {void}
 */
function safeAssign (obj, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true })
  } else {
    obj[key] = value
  }
}

/**
 * Iteratively flattens nested context attributes into dot-notation keys and removes
 * the top-level targetingKey (emitted separately as targeting_key). Uses an explicit
 * work stack plus an ancestor-container set with add-on-descent / delete-on-post-visit,
 * so cyclic contexts truncate at the ancestor repeat instead of overflowing the JS
 * call stack, while sibling references to the same object still emit at both sites.
 * Traversal is capped at MAX_CONTEXT_DEPTH to guard against pathologically deep inputs.
 *
 * @param {Record<string, unknown>} attrs
 * @returns {Record<string, unknown>}
 */
function flattenContext (attrs) {
  if (!attrs) return null

  // An own `__proto__` key (e.g. from a JSON-parsed context) must survive as an
  // enumerable data property. Assigning it to an ordinary `{}` invokes the legacy
  // prototype setter and silently drops the attribute, so leaf emission goes through
  // `safeAssign` (Object.defineProperty for the special key).
  const out = {}
  // ancestors tracks containers currently on the walk path; a container is added
  // when we descend into it and removed after all its descendants are processed.
  // This matches the Java IdentityHashMap add/remove pattern: cycles (ancestor
  // repeats) truncate, but sibling references to the same object still emit.
  const ancestors = new WeakSet()
  // Stack entries are one of:
  //   ['leaf', prefix, value, depth]   → try to emit as scalar
  //   ['exit', value]                  → post-visit marker; remove from ancestors
  const stack = []
  const keys = Object.keys(attrs)
  for (let i = keys.length - 1; i >= 0; i--) {
    const key = keys[i]
    if (key === 'targetingKey') continue
    stack.push(['leaf', key, attrs[key], 1])
  }

  // Bounded traversal: `emitted` counts accepted leaves so a caller-supplied broad
  // array/object cannot push millions of frames or grow `out` past the field cap on
  // the evaluation hot path. Once the cap is reached we stop expanding containers and
  // stop accepting leaves; per-container pushes are also capped at MAX_CONTEXT_FIELDS.
  let emitted = 0

  while (stack.length > 0) {
    const frame = stack.pop()

    if (frame[0] === 'exit') {
      ancestors.delete(frame[1])
      continue
    }

    const prefix = frame[1]
    const value = frame[2]
    const depth = frame[3]

    if (value === undefined ||
        typeof value === 'function' ||
        typeof value === 'symbol' ||
        typeof value === 'bigint') {
      continue
    }

    // Date is a supported OpenFeature scalar-like value, not a traversable record.
    // Serialize to ISO 8601 so the canonical key and the emitted JSON agree; an
    // invalid Date (NaN) is dropped like other unsupported values.
    if (value instanceof Date) {
      if (emitted < MAX_CONTEXT_FIELDS && Number.isFinite(value.getTime())) {
        safeAssign(out, prefix, value.toISOString())
        emitted++
      }
      continue
    }

    const isArray = Array.isArray(value)
    if (isArray || isPlainObject(value)) {
      if (depth >= MAX_CONTEXT_DEPTH) continue
      if (ancestors.has(value)) continue // cycle — truncate
      // Leaves beyond the field cap can never survive pruning, so descending into
      // further containers once the cap is reached only burns memory/time.
      if (emitted >= MAX_CONTEXT_FIELDS) continue

      ancestors.add(value)
      stack.push(['exit', value])

      if (isArray) {
        // Cap children pushed per container: leaves beyond MAX_CONTEXT_FIELDS can never
        // survive, so pushing them only grows the stack. Bounds a million-element
        // array to ≤ MAX_CONTEXT_FIELDS frames here instead of ≤1,000,000.
        const len = Math.min(value.length, MAX_CONTEXT_FIELDS)
        for (let i = len - 1; i >= 0; i--) {
          stack.push(['leaf', `${prefix}.${i}`, value[i], depth + 1])
        }
      } else {
        const childKeys = Object.keys(value)
        const len = Math.min(childKeys.length, MAX_CONTEXT_FIELDS)
        for (let i = len - 1; i >= 0; i--) {
          const k = childKeys[i]
          stack.push(['leaf', `${prefix}.${k}`, value[k], depth + 1])
        }
      }
      continue
    }

    if (emitted < MAX_CONTEXT_FIELDS) {
      safeAssign(out, prefix, value)
      emitted++
    }
  }
  return out
}

/**
 * Returns true when `attrs` can skip the full flatten pass entirely: every value is
 * a supported scalar (no nested object or array to expand, no unsupported types to
 * drop), no string exceeds MAX_FIELD_LENGTH, and the top-level field count is within
 * MAX_CONTEXT_FIELDS. Matches Go's contextFitsWithoutFlattening fast path.
 *
 * @param {Record<string, unknown>} attrs
 * @returns {boolean}
 */
function contextFitsWithoutFlattening (attrs) {
  const keys = Object.keys(attrs)
  // targetingKey is stripped downstream but doesn't itself force a flatten.
  let effectiveCount = 0
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    if (k === 'targetingKey') continue
    effectiveCount++
    if (effectiveCount > MAX_CONTEXT_FIELDS) return false

    const v = attrs[k]
    const t = typeof v
    if (t === 'string') {
      if (v.length > MAX_FIELD_LENGTH) return false
      continue
    }
    if (t === 'number' || t === 'boolean' || v === null) continue
    // undefined, function, symbol, bigint would be dropped by flatten; object/array
    // needs expansion. Either way, take the slow path so semantics stay identical.
    return false
  }
  return true
}

/**
 * Flattens and prunes the evaluation context to at most MAX_CONTEXT_FIELDS fields,
 * sorting keys deterministically and skipping string values longer than MAX_FIELD_LENGTH.
 * Mirrors flageval-worker MAX_EVALUATION_CONTEXT_FIELDS / MAX_FIELD_LENGTH exactly.
 *
 * Two allocation shortcuts (see Go PR #4886):
 *  1. If every top-level value is a supported scalar and the top-level count fits,
 *     skip the whole flatten allocation and just build the sorted output directly
 *     from the raw attrs. This is the common case.
 *  2. If flatten already fits (≤ MAX_CONTEXT_FIELDS, no oversized string), sort the
 *     flatten output in place and return it without allocating a second map.
 *
 * @param {Record<string, unknown>} attrs - Raw context attributes
 * @returns {Record<string, unknown>}
 */
function pruneContext (attrs) {
  if (!attrs) return null

  // Fast path: no flatten needed. Just sort + strip targetingKey.
  if (contextFitsWithoutFlattening(attrs)) {
    const keys = Object.keys(attrs)
    // Track whether any field survived at the assignment site — avoids both a for-in
    // presence probe (AGENTS.md: never use for-in) and an Object.keys().length probe
    // (materializes the key array) on the evaluation hot path.
    let emitted = false
    keys.sort()
    const out = {}
    for (const k of keys) {
      if (k === 'targetingKey') continue
      safeAssign(out, k, attrs[k])
      emitted = true
    }
    return emitted ? out : null
  }

  const flat = flattenContext(attrs)
  if (!flat) return null
  const flatKeys = Object.keys(flat)
  if (flatKeys.length === 0) return null

  flatKeys.sort()

  // Shortcut: if flatten already fits and no oversized strings, reuse flat by
  // rebuilding it in sorted order without allocating a separate pruned map layer
  // beyond what the sort demands. (JS objects preserve insertion order, so we
  // must build a new object to guarantee canonical iteration order for the caller.)
  let needsFieldSkip = flatKeys.length > MAX_CONTEXT_FIELDS
  if (!needsFieldSkip) {
    for (let i = 0; i < flatKeys.length; i++) {
      const v = flat[flatKeys[i]]
      if (typeof v === 'string' && v.length > MAX_FIELD_LENGTH) {
        needsFieldSkip = true
        break
      }
    }
  }

  const out = {}
  if (!needsFieldSkip) {
    for (const k of flatKeys) safeAssign(out, k, flat[k])
    return out
  }

  let count = 0
  let emitted = false
  for (const k of flatKeys) {
    if (count >= MAX_CONTEXT_FIELDS) break
    const v = flat[k]
    if (typeof v === 'string' && v.length > MAX_FIELD_LENGTH) continue
    safeAssign(out, k, v)
    count++
    emitted = true
  }
  return emitted ? out : null
}

/**
 * @param {string} metric
 * @param {number} value
 * @param {string | undefined} reason
 * @returns {void}
 */
function countMetric (metric, value, reason) {
  if (value <= 0) return
  const tags = reason === undefined ? undefined : { reason }
  tracerMetrics.count(metric, tags).inc(value)
}

/**
 * @param {object} event
 * @returns {number}
 */
function eventEvaluationCount (event) {
  const count = event.evaluation_count
  return typeof count === 'number' && count > 0 ? count : 1
}

/**
 * Builds the full-tier bucket key string from schema-visible dimensions only.
 *
 * @param {string} flagKey
 * @param {string} variant
 * @param {string} allocationKey
 * @param {string} errorMessage
 * @param {string} targetingKey
 * @param {string} ctxKey
 * @returns {string}
 */
function makeFullKey (flagKey, variant, allocationKey, errorMessage, targetingKey, ctxKey) {
  // Every dimension is length-delimited so a NUL inside any dimension cannot collide
  // with the separator. ctxKey is already length-delimited via canonicalContextKey.
  return appendLengthDelimited(Buffer.from(flagKey, 'utf8')) +
    appendLengthDelimited(Buffer.from(variant, 'utf8')) +
    appendLengthDelimited(Buffer.from(allocationKey, 'utf8')) +
    appendLengthDelimited(Buffer.from(errorMessage, 'utf8')) +
    appendLengthDelimited(Buffer.from(targetingKey, 'utf8')) +
    ctxKey
}

/**
 * Builds the degraded-tier bucket key string (drops targetingKey + context).
 *
 * @param {string} flagKey
 * @param {string} variant
 * @param {string} allocationKey
 * @param {string} errorMessage
 * @returns {string}
 */
function makeDegradedKey (flagKey, variant, allocationKey, errorMessage) {
  return appendLengthDelimited(Buffer.from(flagKey, 'utf8')) +
    appendLengthDelimited(Buffer.from(variant, 'utf8')) +
    appendLengthDelimited(Buffer.from(allocationKey, 'utf8')) +
    appendLengthDelimited(Buffer.from(errorMessage, 'utf8'))
}

/**
 * @typedef {object} FlagEvalRawEvent
 * @property {string} flagKey
 * @property {string} variant - empty string means absent (runtime_default)
 * @property {string} allocationKey
 * @property {string} targetingKey
 * @property {string} errorMessage
 * @property {number} evalTimeMs
 * @property {Record<string, unknown>} attrs - Flattened and pruned context attributes
 */

/**
 * @typedef {object} FullEntry
 * @property {string} flagKey
 * @property {string} variant
 * @property {string} allocationKey
 * @property {string} targetingKey
 * @property {string} errorMessage
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
 * @property {string} errorMessage
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
 * Cost split between the eval hot path and the deferred drain:
 *   - Hot path (`enqueue`, called synchronously from the OpenFeature `finally` hook):
 *       scalar extraction, `pruneContext` (flatten + sort + rebuild), queue push, and
 *       `setImmediate` scheduling. `pruneContext` dominates once the context carries
 *       nested attributes; the `contextFitsWithoutFlattening` fast path skips flatten
 *       entirely when every top-level value is a supported scalar under the field cap
 *       (the common case), reducing hot-path work to keys-sort + object rebuild.
 *   - Deferred (`_drainQueue` on `setImmediate`, or synchronously from `flush`):
 *       canonical-context key computation, two-tier map aggregation, payload encoding,
 *       size-based batching, and HTTP send.
 *
 * The pruning is required inline because the OpenFeature JS SDK's `hookContext.context`
 * is a shallow-merged object whose nested values share references with caller state.
 * Deferring the flatten would let the walk observe post-hook mutations to those nested
 * values, emitting data that does not match the evaluation-time context. Matches the
 * dd-trace-java semantics (`DDEvaluator.snapshotValues` inline, `flattenValues` deferred).
 *
 * Aggregation caps: globalCap=131072 / perFlagCap=10000 / degradedCap=32768
 * Context bounds: 256 fields / 256 chars (pruned before keying).
 * Killswitch: DD_FEATURE_FLAGS_EVALUATION_COUNTS_ENABLED (checked by the provider).
 */
class FlagEvaluationsWriter extends BaseFFEWriter {
  /** @type {Record<string, unknown>} */
  _context

  /** @type {boolean} whether the Agent advertises /evp_proxy/v2 (gates flush); disabled until the probe enables it */
  #enabled = false

  /** @type {Array<FlagEvalRawEvent>} bounded hand-off queue, drained by the aggregator */
  _rawQueue

  /** @type {boolean} whether a drain is already scheduled (microtask coalescing) */
  _drainScheduled

  /** @type {() => void} cached drain callback to avoid per-enqueue closure allocation */
  _boundDrain

  /** @type {string} precomputed JSON payload prefix ("{context:...,flagEvaluations:[") */
  _payloadPrefix

  /** @type {string} precomputed JSON payload suffix ("]}") */
  _payloadSuffix

  /** @type {number} precomputed UTF-8 byte size of prefix + suffix */
  _basePayloadSizeBytes

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
    super({
      config,
      endpoint: joinEVPProxyPath(EVP_PROXY_PATH_V2, FLAGEVALUATIONS_ENDPOINT),
      interval: 10_000,
      payloadSizeLimit: EVP_PAYLOAD_SIZE_LIMIT,
      eventSizeLimit: EVP_EVENT_SIZE_LIMIT,
      headers: {
        [EVP_SUBDOMAIN_HEADER_NAME]: EVP_EVENT_PLATFORM_SUBDOMAIN,
      },
    })

    const context = { service: config.service }
    if (config.version !== undefined) context.version = config.version
    if (config.env !== undefined) context.env = config.env
    this._context = context

    this._rawQueue = []
    this._drainScheduled = false
    this._boundDrain = () => this._drainQueue()
    this._droppedQueueOverflow = 0

    this._full = new Map()
    this._degraded = new Map()
    this._perFlagFullCount = new Map()
    this._globalCount = 0
    this._droppedDegradedOverflow = 0

    // Payload wrapper is immutable after construction — precompute once.
    this._payloadPrefix = `{"context":${this._encode(this._context)},"flagEvaluations":[`
    this._payloadSuffix = ']}'
    this._basePayloadSizeBytes = Buffer.byteLength(this._payloadPrefix) + Buffer.byteLength(this._payloadSuffix)
  }

  /**
   * Hot-path capture. Called synchronously from the OpenFeature `finally` hook on the
   * caller's evaluation thread. Prunes the caller's evaluation context (flatten + sort
   * + rebuild — required inline; see class-level comment for why), pushes the bounded
   * snapshot onto the queue, and schedules the aggregate drain via `setImmediate`.
   * Canonical-key computation and two-tier map aggregation do NOT run here — those
   * run off the hot path on the scheduled drain.
   *
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
      errorMessage: event.errorMessage ?? '',
      evalTimeMs: event.evalTimeMs,
      attrs: pruneContext(event.attrs || {}),
    })

    if (!this._drainScheduled) {
      this._drainScheduled = true
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
    const errorMessage = event.errorMessage ?? ''
    const attrs = event.attrs || {}

    const ctxKey = canonicalContextKey(attrs)
    const isRuntimeDefault = variant === ''

    const fKey = makeFullKey(flagKey, variant, allocationKey, errorMessage, targetingKey, ctxKey)

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
      this._addToDegraded(flagKey, variant, allocationKey, errorMessage, evalTimeMs, isRuntimeDefault)
      return
    }

    // Increment per-flag attempt count
    this._perFlagFullCount.set(flagKey, perFlagCount + 1)

    // Check global cap
    if (this._globalCount >= this._globalCap) {
      this._addToDegraded(flagKey, variant, allocationKey, errorMessage, evalTimeMs, isRuntimeDefault)
      return
    }

    // New full-tier bucket. `event.attrs` is null when the pruned context was empty
    // (pruneContext returns null), otherwise a non-empty null-prototype map — so no
    // re-probe is needed here to tell empty from non-empty.
    this._full.set(fKey, {
      flagKey,
      variant,
      allocationKey,
      targetingKey,
      errorMessage,
      count: 1,
      first: evalTimeMs,
      last: evalTimeMs,
      runtimeDefault: isRuntimeDefault,
      contextAttrs: event.attrs,
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
   * @param {string} errorMessage
   * @param {number} evalTimeMs
   * @param {boolean} isRuntimeDefault
   */
  _addToDegraded (flagKey, variant, allocationKey, errorMessage, evalTimeMs, isRuntimeDefault) {
    const dKey = makeDegradedKey(flagKey, variant, allocationKey, errorMessage)
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
      errorMessage,
      count: 1,
      first: evalTimeMs,
      last: evalTimeMs,
      runtimeDefault: isRuntimeDefault,
    })
  }

  /**
   * Applies the selected EVP route and gates delivery until route selection completes.
   *
   * @param {boolean} enabled - Whether EVP delivery is available
   * @param {FlagEvaluationRoute} [route] - Selected EVP route
   * @returns {void}
   */
  setEnabled (enabled, route) {
    if (route) {
      this.#setRoute(route)
    }
    this.#enabled = enabled
  }

  /**
   * @param {FlagEvaluationRoute} route - Selected EVP route
   * @returns {void}
   */
  #setRoute (route) {
    const fallbackRoute = route.fallback && {
      url: route.fallback.url,
      endpoint: joinEVPProxyPath(route.fallback.basePath, FLAGEVALUATIONS_ENDPOINT),
      headers: route.fallback.headers ?? {},
      agent: route.fallback.agent,
    }
    const headers = route.headers ?? {
      [EVP_SUBDOMAIN_HEADER_NAME]: EVP_EVENT_PLATFORM_SUBDOMAIN,
    }

    this._setRoutes({
      url: route.url,
      endpoint: joinEVPProxyPath(route.basePath, FLAGEVALUATIONS_ENDPOINT),
      headers,
      agent: route.agent,
    }, fallbackRoute)
  }

  /**
   * Flushes aggregated buckets. Drains any pending event snapshots first so a flush never
   * races ahead of the microtask-scheduled drain and loses queued evaluations.
   */
  flush () {
    // Aggregation remains bounded while delivery is disabled.
    if (!this.#enabled) return

    this._drainQueue()

    const flushTimeMs = Date.now()
    const degradedCardinalityCap = this._degradedEvaluationCount()
    const flagEvaluations = this._drainFlagEvaluations(flushTimeMs)
    const droppedQueueOverflow = this._droppedQueueOverflow
    const droppedDegradedOverflow = this._droppedDegradedOverflow

    this._resetAggregationState()

    countMetric(FLAG_EVALUATION_DROPPED_METRIC, droppedQueueOverflow, DROP_REASON_QUEUE_OVERFLOW)
    countMetric(FLAG_EVALUATION_DROPPED_METRIC, droppedDegradedOverflow, DROP_REASON_DEGRADED_CAP)
    countMetric(FLAG_EVALUATION_DEGRADED_METRIC, degradedCardinalityCap, DEGRADED_REASON_CARDINALITY_CAP)

    if (droppedQueueOverflow > 0 || droppedDegradedOverflow > 0) {
      log.warn(
        '%s dropped evaluations (queue overflow: %d, degraded overflow: %d)',
        this.constructor.name, droppedQueueOverflow, droppedDegradedOverflow
      )
    }

    const payloadStats = this._flushPayloadBatches(flagEvaluations)
    countMetric(FLAG_EVALUATION_DROPPED_METRIC, payloadStats.droppedPayloadLimit, DROP_REASON_PAYLOAD_LIMIT)
    countMetric(FLAG_EVALUATION_DEGRADED_METRIC, payloadStats.degradedPayloadLimit, DEGRADED_REASON_PAYLOAD_LIMIT)
    if (payloadStats.sentPayloads > 1) {
      countMetric(FLAG_EVALUATION_SPLITS_METRIC, payloadStats.sentPayloads - 1)
    }
  }

  /**
   * @private
   * @param {number} flushTimeMs
   * @returns {Array<object>}
   */
  _drainFlagEvaluations (flushTimeMs) {
    const flagEvaluations = []

    // Full tier: all optional fields (variant, allocation, targeting_key, context)
    for (const entry of this._full.values()) {
      // `runtime_default_used` is a required boolean in the flagevaluation event
      // contract (the bundled flagging-core serializer always emits it), so it is
      // set in the literal for every evaluation rather than omitted when false.
      const ev = {
        timestamp: flushTimeMs,
        flag: { key: entry.flagKey },
        first_evaluation: entry.first,
        last_evaluation: entry.last,
        evaluation_count: entry.count,
        runtime_default_used: entry.runtimeDefault,
      }

      if (entry.targetingKey) ev.targeting_key = entry.targetingKey
      if (entry.variant) ev.variant = { key: entry.variant }
      if (entry.allocationKey) ev.allocation = { key: entry.allocationKey }
      if (entry.errorMessage) ev.error = { message: entry.errorMessage }
      // `contextAttrs` is null when the pruned context was empty (see _aggregate);
      // when non-null it is guaranteed non-empty, so no re-probe is needed here.
      if (entry.contextAttrs !== null) {
        ev.context = { evaluation: entry.contextAttrs }
      }

      flagEvaluations.push(ev)
    }

    // Degraded tier: required fields + variant + allocation; NO targeting_key, NO context
    for (const entry of this._degraded.values()) {
      const ev = {
        timestamp: flushTimeMs,
        flag: { key: entry.flagKey },
        first_evaluation: entry.first,
        last_evaluation: entry.last,
        evaluation_count: entry.count,
        runtime_default_used: entry.runtimeDefault,
      }

      if (entry.variant) ev.variant = { key: entry.variant }
      if (entry.allocationKey) ev.allocation = { key: entry.allocationKey }
      if (entry.errorMessage) ev.error = { message: entry.errorMessage }

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
    const payloadPrefix = this._payloadPrefix
    const payloadSuffix = this._payloadSuffix
    const basePayloadSizeBytes = this._basePayloadSizeBytes

    const stats = {
      sentPayloads: 0,
      droppedPayloadLimit: 0,
      degradedPayloadLimit: 0,
    }
    let batch = []
    let batchSizeBytes = basePayloadSizeBytes

    for (const event of flagEvaluations) {
      const encodedEvent = this._encodeEventForPayload(event, basePayloadSizeBytes)
      if (encodedEvent === undefined) {
        stats.droppedPayloadLimit += eventEvaluationCount(event)
        continue
      }
      if (encodedEvent.degraded) {
        stats.degradedPayloadLimit += eventEvaluationCount(event)
      }

      const separatorBytes = batch.length > 0 ? 1 : 0
      const candidateSizeBytes = batchSizeBytes + separatorBytes + encodedEvent.sizeBytes

      if (this._payloadSizeLimit && candidateSizeBytes > this._payloadSizeLimit && batch.length > 0) {
        this._sendPayload(payloadPrefix + batch.join(',') + payloadSuffix, batch.length)
        stats.sentPayloads++
        batch = []
        batchSizeBytes = basePayloadSizeBytes
      }

      const nextSeparatorBytes = batch.length > 0 ? 1 : 0
      batch.push(encodedEvent.json)
      batchSizeBytes += nextSeparatorBytes + encodedEvent.sizeBytes
    }

    if (batch.length > 0) {
      this._sendPayload(payloadPrefix + batch.join(',') + payloadSuffix, batch.length)
      stats.sentPayloads++
    }

    return stats
  }

  /**
   * Encodes one event and applies the payload-limit fallback for oversized full-tier rows.
   *
   * @private
   * @param {object} event
   * @param {number} basePayloadSizeBytes
   * @returns {{ json: string, sizeBytes: number, degraded: boolean } | undefined}
   */
  _encodeEventForPayload (event, basePayloadSizeBytes) {
    const encodedEvent = this._encodeEvent(event)
    if (this._encodedEventFits(encodedEvent.sizeBytes, basePayloadSizeBytes)) {
      return { ...encodedEvent, degraded: false }
    }

    const degradedEvent = this._degradeEventForPayloadLimit(event)
    if (degradedEvent !== undefined) {
      const encodedDegradedEvent = this._encodeEvent(degradedEvent)
      if (this._encodedEventFits(encodedDegradedEvent.sizeBytes, basePayloadSizeBytes)) {
        return { ...encodedDegradedEvent, degraded: true }
      }
      this._dropOversizedEvent(encodedDegradedEvent.sizeBytes, basePayloadSizeBytes)
      return
    }

    this._dropOversizedEvent(encodedEvent.sizeBytes, basePayloadSizeBytes)
  }

  /**
   * Encodes one flag evaluation event and records its UTF-8 byte size.
   *
   * @private
   * @param {object} event
   * @returns {{ json: string, sizeBytes: number }}
   */
  _encodeEvent (event) {
    const json = this._encode(event)
    return { json, sizeBytes: Buffer.byteLength(json) }
  }

  /**
   * Checks whether one already-encoded event can fit in an otherwise-empty payload.
   *
   * @private
   * @param {number} eventSizeBytes
   * @param {number} basePayloadSizeBytes
   * @returns {boolean}
   */
  _encodedEventFits (eventSizeBytes, basePayloadSizeBytes) {
    if (this._eventSizeLimit && eventSizeBytes > this._eventSizeLimit) return false
    if (this._payloadSizeLimit && basePayloadSizeBytes + eventSizeBytes > this._payloadSizeLimit) return false
    return true
  }

  /**
   * Removes customer-identifying fields from a full-tier event before dropping it for size.
   *
   * @private
   * @param {object} event
   * @returns {object | undefined}
   */
  _degradeEventForPayloadLimit (event) {
    if (!Object.hasOwn(event, 'targeting_key') && !Object.hasOwn(event, 'context')) return

    const degraded = { ...event }
    delete degraded.targeting_key
    delete degraded.context
    return degraded
  }

  /**
   * Records and logs that one already-degraded event cannot fit within configured limits.
   *
   * @private
   * @param {number} eventSizeBytes
   * @param {number} basePayloadSizeBytes
   * @returns {void}
   */
  _dropOversizedEvent (eventSizeBytes, basePayloadSizeBytes) {
    if (this._eventSizeLimit && eventSizeBytes > this._eventSizeLimit) {
      log.warn('%s event size %d bytes exceeds limit %d, dropping event',
        this.constructor.name, eventSizeBytes, this._eventSizeLimit)
    } else {
      log.warn('%s payload size %d bytes exceeds limit %d, dropping event',
        this.constructor.name, basePayloadSizeBytes + eventSizeBytes, this._payloadSizeLimit)
    }
    this._droppedEvents++
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

  /**
   * @private
   * @returns {number}
   */
  _degradedEvaluationCount () {
    let count = 0
    for (const entry of this._degraded.values()) {
      count += entry.count
    }
    return count
  }
}

module.exports = FlagEvaluationsWriter
module.exports._capSizingForTest = {
  EVAL_SCALE_FULL_BUCKET_TARGET,
  EVAL_SCALE_DEGRADED_BUCKET_TARGET,
  GLOBAL_CAP,
  PER_FLAG_CAP,
  DEGRADED_CAP,
}
