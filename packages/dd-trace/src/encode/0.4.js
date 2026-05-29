'use strict'

const getConfig = require('../config')
const { MsgpackChunk } = require('../msgpack')
const log = require('../log')
const { normalizeSpan } = require('./tags-processors')

const SOFT_LIMIT = 8 * 1024 * 1024 // 8MB
// Values longer than this byte threshold skip the `_stringMap` lookup and
// emit through `bytes.write` directly. Hashing a multi-KiB string for
// `Map.get` costs more than the cache hit saves on the inputs that produce
// strings this long (events JSON, stack traces, large query bodies) — they
// are unique per span, so the cache hit rate stays near zero anyway.
const STRING_CACHE_BYPASS_LIMIT = 1024

// Pre-encoded static keys + value-prefix bytes; the hot encode loop emits
// each via one Uint8Array.set instead of routing through the string cache.

/**
 * @param {string} key fixstr key, must be < 32 UTF-8 bytes.
 * @returns {Buffer}
 */
function buildKey (key) {
  const length = Buffer.byteLength(key)
  const buffer = Buffer.allocUnsafe(length + 1)
  buffer[0] = length | 0xA0
  buffer.utf8Write(key, 1, length)
  return buffer
}

/**
 * @param {string} key fixstr key, must be < 32 UTF-8 bytes.
 * @param {number} prefix msgpack prefix byte for the value that follows the key.
 * @returns {Buffer}
 */
function buildKeyWithPrefix (key, prefix) {
  const length = Buffer.byteLength(key)
  const buffer = Buffer.allocUnsafe(length + 2)
  buffer[0] = length | 0xA0
  buffer.utf8Write(key, 1, length)
  buffer[length + 1] = prefix
  return buffer
}

const KEY_TYPE = buildKey('type')
const KEY_NAME = buildKey('name')
const KEY_RESOURCE = buildKey('resource')
const KEY_SERVICE = buildKey('service')
const KEY_ERROR = buildKey('error')
const KEY_START = buildKey('start')
const KEY_DURATION = buildKey('duration')

// Fused `[KEY_ERROR, fixint]` payloads. `error` is `0` or `1` on nearly every
// span (the boolean-shaped tracer field collapsed onto a single byte). One
// `bytes.set` writes the key and the value together instead of routing the
// value through `writeIntOrFloat`'s reserve + branch table.
const KEY_ERROR_0 = Buffer.concat([KEY_ERROR, Buffer.from([0x00])])
const KEY_ERROR_1 = Buffer.concat([KEY_ERROR, Buffer.from([0x01])])
// `[KEY_START, 0xCF]` — `start` is always a nanosecond timestamp ≥ 2³², so
// the msgpack u64 type byte is statically known and fuses with the key. The
// 8-byte value is written inline right after.
const KEY_START_PREFIX = buildKeyWithPrefix('start', 0xCF)
const KEY_SPAN_EVENTS = buildKey('span_events')
const KEY_META_STRUCT = buildKey('meta_struct')
const KEY_TRACE_ID_PREFIX = buildKeyWithPrefix('trace_id', 0xCF)
const KEY_SPAN_ID_PREFIX = buildKeyWithPrefix('span_id', 0xCF)
const KEY_PARENT_ID_PREFIX = buildKeyWithPrefix('parent_id', 0xCF)
const KEY_META_PREFIX = buildKeyWithPrefix('meta', 0xDF)
const KEY_METRICS_PREFIX = buildKeyWithPrefix('metrics', 0xDF)

// Span-event field keys — `name` is shared with the span-level KEY_NAME.
const KEY_EVENT_TIME = buildKey('time_unix_nano')
const KEY_EVENT_ATTRIBUTES = buildKey('attributes')

// Pre-encoded prefix for a span-event-attribute typed wrapper:
//   `[0x82 fixmap(2), 'type' fixstr, type fixint, '<value>_value' fixstr]`.
// The hot path emits one of these constants + the raw value, so the encoder
// never has to allocate `{ type: N, *_value: ... }` wrappers.
function buildAttrPrefix (typeByte, valueKey) {
  const valueKeyBuf = buildKey(valueKey)
  const buf = Buffer.allocUnsafe(7 + valueKeyBuf.length)
  buf[0] = 0x82
  buf[1] = 0xA4
  buf[2] = 0x74 // t
  buf[3] = 0x79 // y
  buf[4] = 0x70 // p
  buf[5] = 0x65 // e
  buf[6] = typeByte
  valueKeyBuf.copy(buf, 7)
  return buf
}

const ATTR_PREFIX_STRING = buildAttrPrefix(0x00, 'string_value')
const ATTR_PREFIX_BOOL = buildAttrPrefix(0x01, 'bool_value')
const ATTR_PREFIX_INT = buildAttrPrefix(0x02, 'int_value')
const ATTR_PREFIX_DOUBLE = buildAttrPrefix(0x03, 'double_value')

// Outer array attribute is the only nested case: `[0x82, 'type', 4,
// 'array_value', 0x81 fixmap(1), 'values', 0xDD array32-prefix]`. The 4-byte
// length slot follows.
const ATTR_PREFIX_ARRAY = Buffer.concat([
  buildAttrPrefix(0x04, 'array_value'),
  Buffer.from([0x81]),
  buildKey('values'),
  Buffer.from([0xDD]),
])

// Pre-encoded boolean payloads: `[ATTR_PREFIX_BOOL, 0xC3 / 0xC2]`. Used by
// `#emitAttribute` and `#emitArrayItem` to emit the whole bool wrapper in a
// single `bytes.set`.
const ATTR_PAYLOAD_BOOL_TRUE = Buffer.concat([ATTR_PREFIX_BOOL, Buffer.from([0xC3])])
const ATTR_PAYLOAD_BOOL_FALSE = Buffer.concat([ATTR_PREFIX_BOOL, Buffer.from([0xC2])])

// Steady-state string cache shared across every `AgentEncoder` instance in
// the process. The keys / values listed below are emitted on (close to)
// every payload from a typical web service — caching them once at module
// load lets every `_reset()` start with them already encoded instead of
// running `_cacheString` for each one per payload boundary. Entries point
// into `STEADY_STRING_BUFFER`; `#refreshStringCache` skips them via the
// `ArrayBuffer` identity check so a `_stringBytes` resize does not corrupt
// them.
const STEADY_STRING_KEYS = Object.freeze([
  // Wire string for the empty value — emitted as a missing-field placeholder
  // and as the meta-struct empty-map sentinel. Reserved first so the index
  // matches what `_cacheString('')` used to produce.
  '',
  // `extractTags` adds these on every span via `config.tags`.
  'language',
  'process_id',
  'runtime-id',
  'service',
  'version',
  'env',
  // Trace-level sampling and routing tags written by the sampler /
  // priority sampler on the local root span.
  '_sampling_priority_v1',
  '_dd.hostname',
  '_dd.origin',
  '_dd.measured',
  '_dd.base_service',
  '_dd.agent_psr',
  '_dd.p.dm',
  '_dd.p.tid',
  // Universal span shape tags.
  'component',
  'span.kind',
  'resource.name',
  'operation.name',
  // HTTP server / client spans. The web plugin emits these per request.
  'http.url',
  'http.method',
  'http.status_code',
  'http.useragent',
  'http.route',
  'http.client_ip',
  'http.host',
  // Common DB / messaging / RPC tags. Always emitted by the relevant plugin.
  'db.type',
  'db.name',
  'db.instance',
  'db.statement',
  'db.system',
  'peer.hostname',
  'peer.service',
  'out.host',
  'out.port',
  'network.destination.port',
  'rpc.system',
  'rpc.service',
  'rpc.method',
  // Error envelope.
  'error.type',
  'error.message',
  'error.stack',
])

// Values that recur on essentially every payload — pre-encoding them lets the
// string cache hit on a tag value too, not just the key.
const STEADY_STRING_VALUES = Object.freeze([
  // The only `language` value the tracer ever writes.
  'javascript',
  // OTel-style `span.kind` enum values.
  'client',
  'server',
  'producer',
  'consumer',
  'internal',
  // HTTP methods.
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
])

// One backing `MsgpackChunk` for the whole process. `_stringMap` clones the
// derived entries on every `_reset()` so each `AgentEncoder` instance gets a
// per-payload cache that already includes the steady set.
const STEADY_STRING_BUFFER = new MsgpackChunk()
const STEADY_STRING_ENTRIES = Object.create(null)
for (const value of STEADY_STRING_KEYS) {
  const start = STEADY_STRING_BUFFER.length
  const written = STEADY_STRING_BUFFER.write(value)
  STEADY_STRING_ENTRIES[value] = STEADY_STRING_BUFFER.buffer.subarray(start, start + written)
}
for (const value of STEADY_STRING_VALUES) {
  if (STEADY_STRING_ENTRIES[value] !== undefined) continue
  const start = STEADY_STRING_BUFFER.length
  const written = STEADY_STRING_BUFFER.write(value)
  STEADY_STRING_ENTRIES[value] = STEADY_STRING_BUFFER.buffer.subarray(start, start + written)
}

// `_stringBytes` resizes detected via `Buffer.buffer` identity — the steady
// entries share this `ArrayBuffer` and must be skipped during refresh.
const STEADY_STRING_ARRAY_BUFFER = STEADY_STRING_BUFFER.buffer.buffer

function formatSpanWithLegacyEvents (span) {
  span = normalizeSpan(span)
  if (span.span_events) {
    // TODO: this is currently a main cost driver. By unifying it with the formatter
    // it should be possible to improve performance significantly overall.
    span.meta.events = stringifySpanEvents(span.span_events)
    // `= undefined` over `delete` to keep the span's hidden class — `delete`
    // would push every event-bearing span into V8 dictionary mode.
    span.span_events = undefined
  }
  return span
}

/**
 * Hand-written stringifier for `span.span_events`. The shape is fixed by
 * `extractSpanEvents` (`{ name, time_unix_nano, attributes? }`) and attribute
 * values are pre-sanitized to primitives or arrays of primitives, so we can
 * skip everything `JSON.stringify` does for the generic case (toJSON probing,
 * key iteration over the prototype chain, replacer hooks). Output matches
 * `JSON.stringify(spanEvents)` byte-for-byte for the post-sanitization shape.
 *
 * @param {Array<{ name: string, time_unix_nano: number, attributes?: object }>} spanEvents
 * @returns {string}
 */
function stringifySpanEvents (spanEvents) {
  let result = '['
  for (let index = 0; index < spanEvents.length; index++) {
    if (index > 0) result += ','
    const event = spanEvents[index]
    // `addEvent` does not type-check `name`; defer the unusual cases to
    // `JSON.stringify` so non-string names match the prior behaviour
    // instead of throwing in `escapeJsonString`.
    if (typeof event.name !== 'string') {
      result += JSON.stringify(event)
      continue
    }
    result += '{"name":' + escapeJsonString(event.name) +
      ',"time_unix_nano":' + jsonNumber(event.time_unix_nano)
    if (event.attributes) {
      result += ',"attributes":' + stringifyAttributes(event.attributes)
    }
    result += '}'
  }
  return result + ']'
}

function stringifyAttributes (attributes) {
  let result = '{'
  let first = true
  for (const key of Object.keys(attributes)) {
    if (first) {
      first = false
    } else {
      result += ','
    }
    result += escapeJsonString(key) + ':' + stringifyAttributeValue(attributes[key])
  }
  return result + '}'
}

function stringifyAttributeValue (value) {
  if (typeof value === 'string') return escapeJsonString(value)
  if (typeof value === 'number') return jsonNumber(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) {
    let result = '['
    for (let index = 0; index < value.length; index++) {
      if (index > 0) result += ','
      result += stringifyAttributeValue(value[index])
    }
    return result + ']'
  }
  // Sanitization rejects everything else, but keep the safety net.
  return 'null'
}

/**
 * Match `JSON.stringify` for numbers: `NaN` and `±Infinity` collapse to the
 * literal `null`, everything else uses ECMAScript's default `Number → String`
 * conversion (which is what `JSON.stringify` calls internally).
 *
 * @param {number} value
 * @returns {string}
 */
function jsonNumber (value) {
  if (Number.isFinite(value)) return String(value)
  return 'null'
}

/**
 * Fast path: scan once, and if no character in the string requires JSON
 * escaping, emit `"<str>"` as-is. The scanned chars are `"`, `\`, and any
 * control char in the U+0000–U+001F range. Anything else delegates to
 * `JSON.stringify` for full spec-compliant escaping (surrogate pairs,
 * lone surrogates, etc.).
 *
 * @param {string} value
 * @returns {string}
 */
function escapeJsonString (value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x22 || code === 0x5C) {
      return JSON.stringify(value)
    }
  }
  return '"' + value + '"'
}

function lazyEncodedTraceBufferLogger (bytes, start, end) {
  const hex = bytes.buffer.subarray(start, end).toString('hex').match(/../g).join(' ')
  return `Adding encoded trace to buffer: ${hex}`
}

class AgentEncoder {
  #limit
  #writer
  #config
  #debugEncoding
  #formatSpan

  constructor (writer, limit = SOFT_LIMIT) {
    this.#limit = limit
    this._traceBytes = new MsgpackChunk()
    this._stringBytes = new MsgpackChunk()
    this.#writer = writer
    this._reset()
    this.#config = getConfig()
    this.#debugEncoding = this.#config.DD_TRACE_ENCODING_DEBUG
    // Pick the per-span formatter once so the hot loop pays no per-span
    // config check. The native path doesn't need to reshape `span_events`
    // because `#encodeSpanEvents` works directly on the raw attributes.
    this.#formatSpan = this.#config.DD_TRACE_NATIVE_SPAN_EVENTS
      ? normalizeSpan
      : formatSpanWithLegacyEvents
  }

  count () {
    return this._traceCount
  }

  encode (trace) {
    const bytes = this._traceBytes
    const start = bytes.length

    this._traceCount++

    this._encode(bytes, trace)

    if (this.#debugEncoding) {
      const end = bytes.length
      log.debug(lazyEncodedTraceBufferLogger, bytes, start, end)
    }

    // Soft limit overshoot is fine — the agent caps at 50 MB.
    if (this._traceBytes.length > this.#limit || this._stringBytes.length > this.#limit) {
      log.debug('Buffer went over soft limit, flushing')
      this.#writer.flush()
    }
  }

  makePayload () {
    const traceSize = this._traceBytes.length + 5
    const buffer = Buffer.allocUnsafe(traceSize)

    this._writeTraces(buffer)

    this._reset()

    return buffer
  }

  reset () {
    this._reset()
  }

  _encode (bytes, trace) {
    bytes.writeArrayPrefix(trace)

    const formatSpan = this.#formatSpan
    const stringMap = this._stringMap
    // Snapshot the string buffer so we can detect a mid-encode resize and
    // release the old backing store afterwards (see `#refreshStringCache`).
    const stringBufferAtStart = this._stringBytes.buffer

    for (let span of trace) {
      span = formatSpan(span)

      let mapSize = 11
      if (span.type) mapSize++
      if (span.meta_struct) mapSize++
      if (span.span_events) mapSize++

      // Pre-fetch the cached string entries up front and fuse the map prefix,
      // optional `type`, three IDs, `name` / `resource` / `service`, and —
      // in the common fixint-error case — the error/start/duration_key
      // emissions into a single `bytes.reserve` + sequential native writes.
      // Replaces up to ten separate `bytes.reserve` calls per span with one.
      let typeEntry
      if (span.type) {
        typeEntry = stringMap[span.type] ?? this._cacheString(span.type)
      }
      const nameEntry = stringMap[span.name] ?? this._cacheString(span.name)
      const resourceEntry = stringMap[span.resource] ?? this._cacheString(span.resource)
      const serviceEntry = stringMap[span.service] ?? this._cacheString(span.service)
      const nameLen = nameEntry.length
      const resourceLen = resourceEntry.length
      const serviceLen = serviceEntry.length

      // Almost every span carries `error: 0` or `error: 1` AND a nanosecond
      // `start` timestamp ≥ 2³² (so `start` always encodes as a u64). When
      // both hold, the block fuses error key+value, the start key + 0xCF
      // type byte + 8-byte timestamp, and the duration key into the per-span
      // reserve. The fallback path covers synthetic/test inputs with small
      // starts and rare non-binary error flags by keeping per-field emits so
      // each integer picks the shortest msgpack encoding.
      const errorIsFixint = span.error === 0 || span.error === 1
      const startFitsU64 = span.start >= 0x1_00_00_00_00
      const fuseTail = errorIsFixint && startFitsU64

      let blockSize = 1 +
        KEY_TRACE_ID_PREFIX.length + 8 +
        KEY_SPAN_ID_PREFIX.length + 8 +
        KEY_PARENT_ID_PREFIX.length + 8 +
        KEY_NAME.length + nameLen +
        KEY_RESOURCE.length + resourceLen +
        KEY_SERVICE.length + serviceLen
      if (typeEntry) blockSize += KEY_TYPE.length + typeEntry.length
      if (fuseTail) {
        blockSize += KEY_ERROR_0.length + KEY_START_PREFIX.length + 8 + KEY_DURATION.length
      }

      const blockOffset = bytes.length
      bytes.reserve(blockSize)
      const target = bytes.buffer
      let cursor = blockOffset

      target[cursor++] = 0x80 + mapSize

      if (typeEntry) {
        target.set(KEY_TYPE, cursor)
        cursor += KEY_TYPE.length
        target.set(typeEntry, cursor)
        cursor += typeEntry.length
      }

      cursor = this.#writeIdAt(target, cursor, KEY_TRACE_ID_PREFIX, span.trace_id)
      cursor = this.#writeIdAt(target, cursor, KEY_SPAN_ID_PREFIX, span.span_id)
      cursor = this.#writeIdAt(target, cursor, KEY_PARENT_ID_PREFIX, span.parent_id)

      target.set(KEY_NAME, cursor)
      cursor += KEY_NAME.length
      target.set(nameEntry, cursor)
      cursor += nameLen

      target.set(KEY_RESOURCE, cursor)
      cursor += KEY_RESOURCE.length
      target.set(resourceEntry, cursor)
      cursor += resourceLen

      target.set(KEY_SERVICE, cursor)
      cursor += KEY_SERVICE.length
      target.set(serviceEntry, cursor)
      cursor += serviceLen

      if (fuseTail) {
        target.set(span.error === 0 ? KEY_ERROR_0 : KEY_ERROR_1, cursor)
        cursor += KEY_ERROR_0.length

        target.set(KEY_START_PREFIX, cursor)
        cursor += KEY_START_PREFIX.length
        // Inline u64 write so the 0xCF type byte and the 8 timestamp bytes
        // share the same reserve as the keys.
        target.writeUInt32BE((span.start / 0x1_00_00_00_00) >>> 0, cursor)
        target.writeUInt32BE(span.start >>> 0, cursor + 4)
        cursor += 8

        target.set(KEY_DURATION, cursor)
      } else {
        if (span.error === 0) {
          bytes.set(KEY_ERROR_0)
        } else if (span.error === 1) {
          bytes.set(KEY_ERROR_1)
        } else {
          bytes.set(KEY_ERROR)
          bytes.writeIntOrFloat(span.error)
        }
        bytes.set(KEY_START)
        bytes.writeIntOrFloat(span.start)
        bytes.set(KEY_DURATION)
      }
      bytes.writeIntOrFloat(span.duration)

      this.#encodeMetaEntries(bytes, KEY_META_PREFIX, span.meta)
      this.#encodeMetaEntries(bytes, KEY_METRICS_PREFIX, span.metrics)

      if (span.span_events) {
        bytes.set(KEY_SPAN_EVENTS)
        this.#encodeSpanEvents(bytes, span.span_events)
      }
      if (span.meta_struct) {
        bytes.set(KEY_META_STRUCT)
        this.#encodeMetaStruct(bytes, span.meta_struct)
      }
    }

    if (this._stringBytes.buffer !== stringBufferAtStart) {
      this.#refreshStringCache()
    }
  }

  /**
   * Rebuild the cached string subarrays in `_stringMap` against the current
   * `_stringBytes.buffer`. After `MsgpackChunk.reserve()` resizes, the prior
   * subarrays still reference the old `Buffer`'s `ArrayBuffer` and pin it
   * until `_reset()` clears the map; for a payload that grows 2 → 4 → 8 MB
   * that is up to 6 MB of avoidable peak memory. `Buffer.allocUnsafe(>= 2
   * MB)` bypasses the small-allocation pool and starts at offset 0 in its
   * `ArrayBuffer`, so the old subarray's `byteOffset` is the entry's start
   * position in the new buffer.
   *
   * Steady-cache entries point into `STEADY_STRING_BUFFER`, not into
   * `_stringBytes`. Re-subarraying them against `_stringBytes` would corrupt
   * the wire bytes, so the loop skips them via the `ArrayBuffer` identity
   * check.
   */
  #refreshStringCache () {
    const newBuffer = this._stringBytes.buffer
    const stringMap = this._stringMap
    for (const key of Object.keys(stringMap)) {
      const old = stringMap[key]
      if (old.buffer === STEADY_STRING_ARRAY_BUFFER) continue
      stringMap[key] = newBuffer.subarray(old.byteOffset, old.byteOffset + old.length)
    }
  }

  _reset () {
    this._traceCount = 0
    this._traceBytes.reset()
    this._stringCount = 0
    this._stringBytes.reset()

    // The 0.5 subclass replaces `_cacheString` to intern strings into a
    // wire-shipped table (where index 0 must be the empty string), so the
    // module-level steady cache (Buffer subarrays, not indices) does not
    // apply.
    if (this._cacheString === AgentEncoder.prototype._cacheString) {
      this._stringMap = Object.assign(Object.create(null), STEADY_STRING_ENTRIES)
    } else {
      this._stringMap = Object.create(null)
      this._cacheString('')
    }
  }

  // TODO: Use BigInt instead.
  _encodeId (bytes, identifier) {
    const idBuffer = identifier.toBuffer()
    const start = idBuffer.length - 8
    const offset = bytes.length

    bytes.reserve(9)

    const target = bytes.buffer
    target[offset] = 0xCF
    target[offset + 1] = idBuffer[start]
    target[offset + 2] = idBuffer[start + 1]
    target[offset + 3] = idBuffer[start + 2]
    target[offset + 4] = idBuffer[start + 3]
    target[offset + 5] = idBuffer[start + 4]
    target[offset + 6] = idBuffer[start + 5]
    target[offset + 7] = idBuffer[start + 6]
    target[offset + 8] = idBuffer[start + 7]
  }

  // Single pass: reserve the count slot, encode entries while counting, patch the count.
  // Subclasses (0.5, CI visibility encoders) inherit this; the wire stays on float64
  // for numeric values to keep their established trace / events intake unchanged.
  _encodeMap (bytes, value) {
    const offset = bytes.length
    bytes.reserve(5)
    bytes.buffer[offset] = 0xDF

    let count = 0
    for (const key of Object.keys(value)) {
      const entryValue = value[key]
      if (typeof entryValue === 'string') {
        this._encodeString(bytes, key)
        this._encodeString(bytes, entryValue)
        count++
      } else if (typeof entryValue === 'number') {
        this._encodeString(bytes, key)
        bytes.writeFloat(entryValue)
        count++
      }
    }

    const target = bytes.buffer
    target[offset + 1] = count >>> 24
    target[offset + 2] = count >>> 16
    target[offset + 3] = count >>> 8
    target[offset + 4] = count
  }

  _encodeString (bytes, value = '') {
    if (value.length > STRING_CACHE_BYPASS_LIMIT) {
      bytes.write(value)
      return
    }
    const entry = this._stringMap[value] ?? this._cacheString(value)
    const length = entry.length
    const offset = bytes.length
    bytes.reserve(length)
    bytes.buffer.set(entry, offset)
  }

  _cacheString (value) {
    let entry = this._stringMap[value]
    if (entry === undefined) {
      this._stringCount++
      const start = this._stringBytes.length
      const written = this._stringBytes.write(value)
      entry = this._stringBytes.buffer.subarray(start, start + written)
      this._stringMap[value] = entry
    }
    return entry
  }

  _writeArrayPrefix (buffer, offset, count) {
    buffer[offset++] = 0xDD
    buffer.writeUInt32BE(count, offset)

    return offset + 4
  }

  _writeTraces (buffer, offset = 0) {
    offset = this._writeArrayPrefix(buffer, offset, this._traceCount)
    offset += this._traceBytes.buffer.copy(buffer, offset, 0, this._traceBytes.length)

    return offset
  }

  /**
   * Fast path for `span.meta` / `span.metrics`. Inlines the string cache so
   * each entry is one reserve (not two) and skips the polymorphic dispatch.
   *
   * @param {MsgpackChunk} bytes
   * @param {Buffer} keyPrefix Precomputed `[key, 0xDF]`.
   * @param {Record<string, unknown>} value
   */
  #encodeMetaEntries (bytes, keyPrefix, value) {
    const keyPrefixLen = keyPrefix.length
    const headerOffset = bytes.length
    bytes.reserve(keyPrefixLen + 4)
    bytes.buffer.set(keyPrefix, headerOffset)
    const countOffset = headerOffset + keyPrefixLen

    const stringMap = this._stringMap
    let count = 0

    for (const key of Object.keys(value)) {
      const entryValue = value[key]
      if (typeof entryValue !== 'string' && typeof entryValue !== 'number') continue

      const keyEntry = stringMap[key] ?? this._cacheString(key)
      const keyEntryLen = keyEntry.length
      const writeOffset = bytes.length

      if (typeof entryValue === 'string') {
        if (entryValue.length > STRING_CACHE_BYPASS_LIMIT) {
          // Long values (events JSON, stack traces, large query bodies) are
          // unique per span; hashing them for the cache lookup costs more
          // than the lookup ever recovers. Emit the key from the cache and
          // stream the value directly.
          bytes.reserve(keyEntryLen)
          bytes.buffer.set(keyEntry, writeOffset)
          bytes.write(entryValue)
          count++
          continue
        }
        const valueEntry = stringMap[entryValue] ?? this._cacheString(entryValue)
        const valueEntryLen = valueEntry.length
        bytes.reserve(keyEntryLen + valueEntryLen)
        const target = bytes.buffer
        target.set(keyEntry, writeOffset)
        target.set(valueEntry, writeOffset + keyEntryLen)
      } else {
        // Speculate that `entryValue` is a positive fixint (0..127): one
        // reserve covers both the key and the value. The metrics map (sample
        // rate, priority, `_dd.measured`, attribute counts) is mostly small
        // unsigned integers, so the speculation wins on every entry that
        // doesn't go through the slow `writeIntOrFloat` dispatch chain.
        bytes.reserve(keyEntryLen + 1)
        const target = bytes.buffer
        target.set(keyEntry, writeOffset)
        if (entryValue === (entryValue & 0x7F)) {
          target[writeOffset + keyEntryLen] = entryValue
        } else {
          // Speculation missed; rewind the speculative byte and route the
          // value through the full encoder so it picks the right type.
          bytes.length = writeOffset + keyEntryLen
          bytes.writeIntOrFloat(entryValue)
        }
      }
      count++
    }

    const target = bytes.buffer
    target[countOffset] = count >>> 24
    target[countOffset + 1] = count >>> 16
    target[countOffset + 2] = count >>> 8
    target[countOffset + 3] = count
  }

  /**
   * Write `[keyPrefix, 8-byte uint64 id]` into `target` at `offset` and
   * return the new cursor. Caller is responsible for having reserved enough
   * room — this is the no-reserve variant used inside `_encode`'s combined
   * fixed-fields block.
   *
   * @param {Uint8Array} target
   * @param {number} offset
   * @param {Buffer} keyPrefix Precomputed `[key, 0xCF]`.
   * @param {{ toBuffer: () => Uint8Array | number[] }} identifier
   * @returns {number}
   */
  #writeIdAt (target, offset, keyPrefix, identifier) {
    target.set(keyPrefix, offset)
    offset += keyPrefix.length
    const idBuffer = identifier.toBuffer()
    const start = idBuffer.length - 8
    target[offset] = idBuffer[start]
    target[offset + 1] = idBuffer[start + 1]
    target[offset + 2] = idBuffer[start + 2]
    target[offset + 3] = idBuffer[start + 3]
    target[offset + 4] = idBuffer[start + 4]
    target[offset + 5] = idBuffer[start + 5]
    target[offset + 6] = idBuffer[start + 6]
    target[offset + 7] = idBuffer[start + 7]
    return offset + 8
  }

  /**
   * @param {MsgpackChunk} bytes
   * @param {string | number | boolean} value
   */
  #encodeValue (bytes, value) {
    switch (typeof value) {
      case 'string':
        this._encodeString(bytes, value)
        break
      case 'number':
        bytes.writeFloat(value)
        break
      case 'boolean':
        bytes.writeBoolean(value)
        break
    }
  }

  #encodeMetaStruct (bytes, value) {
    if (Array.isArray(value)) {
      bytes.writeMapPrefix(0)
      return
    }

    const offset = bytes.length
    bytes.reserve(5)
    bytes.buffer[offset] = 0xDF

    let count = 0
    for (const key of Object.keys(value)) {
      const entryValue = value[key]
      if (typeof entryValue === 'string' || typeof entryValue === 'number' ||
        (entryValue !== null && typeof entryValue === 'object')) {
        this._encodeString(bytes, key)
        this.#encodeObjectAsByteArray(bytes, entryValue)
        count++
      }
    }

    const target = bytes.buffer
    target[offset + 1] = count >>> 24
    target[offset + 2] = count >>> 16
    target[offset + 3] = count >>> 8
    target[offset + 4] = count
  }

  #encodeObjectAsByteArray (bytes, value) {
    const prefixLength = 5
    const offset = bytes.length

    bytes.reserve(prefixLength)

    this.#encodeObject(bytes, value)

    // The byte length isn't known until the inner object has been encoded.
    const length = bytes.length - offset - prefixLength
    bytes.buffer[offset] = 0xC6
    bytes.buffer[offset + 1] = length >> 24
    bytes.buffer[offset + 2] = length >> 16
    bytes.buffer[offset + 3] = length >> 8
    bytes.buffer[offset + 4] = length
  }

  #encodeObject (bytes, value, circularReferencesDetector = new Set()) {
    circularReferencesDetector.add(value)
    if (Array.isArray(value)) {
      this.#encodeObjectAsArray(bytes, value, circularReferencesDetector)
    } else if (value !== null && typeof value === 'object') {
      this.#encodeObjectAsMap(bytes, value, circularReferencesDetector)
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      this.#encodeValue(bytes, value)
    }
  }

  #encodeObjectAsMap (bytes, value, circularReferencesDetector) {
    const offset = bytes.length
    bytes.reserve(5)
    bytes.buffer[offset] = 0xDF

    let count = 0
    for (const key of Object.keys(value)) {
      const entryValue = value[key]
      if (typeof entryValue === 'string' || typeof entryValue === 'number' || typeof entryValue === 'boolean' ||
        (entryValue !== null && typeof entryValue === 'object' &&
          !circularReferencesDetector.has(entryValue))) {
        this._encodeString(bytes, key)
        this.#encodeObject(bytes, entryValue, circularReferencesDetector)
        count++
      }
    }

    const target = bytes.buffer
    target[offset + 1] = count >>> 24
    target[offset + 2] = count >>> 16
    target[offset + 3] = count >>> 8
    target[offset + 4] = count
  }

  #encodeObjectAsArray (bytes, value, circularReferencesDetector) {
    const offset = bytes.length
    bytes.reserve(5)
    bytes.buffer[offset] = 0xDD

    let count = 0
    for (const item of value) {
      if (typeof item === 'string' || typeof item === 'number' ||
        (item !== null && typeof item === 'object' && !circularReferencesDetector.has(item))) {
        this.#encodeObject(bytes, item, circularReferencesDetector)
        count++
      }
    }

    const target = bytes.buffer
    target[offset + 1] = count >>> 24
    target[offset + 2] = count >>> 16
    target[offset + 3] = count >>> 8
    target[offset + 4] = count
  }

  /**
   * Specialized encoder for `span.span_events`. Walks the events directly,
   * emitting OTel attribute typed wrappers inline from the raw attribute
   * values — no `formatSpanEvents` pre-pass and no recursive generic walk.
   *
   * @param {MsgpackChunk} bytes
   * @param {Array<{ name: string, time_unix_nano: number, attributes?: object }>} spanEvents
   */
  #encodeSpanEvents (bytes, spanEvents) {
    const offset = bytes.length
    bytes.reserve(5)
    bytes.buffer[offset] = 0xDD

    let arrayCount = 0
    for (const event of spanEvents) {
      // `addEvent` and the OTel bridge do not type-check `name`, and a
      // non-string would throw downstream in `Buffer.byteLength`. Drop the
      // bad event silently so the rest of the trace still encodes.
      if (event === null || typeof event !== 'object' || typeof event.name !== 'string') continue

      const eventHeaderOffset = bytes.length
      bytes.reserve(1)
      bytes.buffer[eventHeaderOffset] = 0x82

      bytes.set(KEY_NAME)
      this._encodeString(bytes, event.name)
      bytes.set(KEY_EVENT_TIME)
      bytes.writeFloat(event.time_unix_nano)

      const attributes = event.attributes
      if (attributes !== null && typeof attributes === 'object') {
        this.#encodeAttributesIfAny(bytes, attributes, eventHeaderOffset)
      }
      arrayCount++
    }

    const target = bytes.buffer
    target[offset + 1] = arrayCount >>> 24
    target[offset + 2] = arrayCount >>> 16
    target[offset + 3] = arrayCount >>> 8
    target[offset + 4] = arrayCount
  }

  /**
   * Optimistically emits the `'attributes'` slot for an event. If every entry
   * filters out, the partial output is rewound and the event's map header
   * stays at 2 entries.
   *
   * @param {MsgpackChunk} bytes
   * @param {Record<string, unknown>} attributes
   * @param {number} eventHeaderOffset
   */
  #encodeAttributesIfAny (bytes, attributes, eventHeaderOffset) {
    const sectionStart = bytes.length

    bytes.set(KEY_EVENT_ATTRIBUTES)
    const countOffset = bytes.length
    bytes.reserve(5)
    bytes.buffer[countOffset] = 0xDF

    let count = 0
    for (const key of Object.keys(attributes)) {
      if (this.#emitAttribute(bytes, key, attributes[key])) count++
    }

    if (count === 0) {
      bytes.length = sectionStart
      return
    }

    const target = bytes.buffer
    target[countOffset + 1] = count >>> 24
    target[countOffset + 2] = count >>> 16
    target[countOffset + 3] = count >>> 8
    target[countOffset + 4] = count
    bytes.buffer[eventHeaderOffset] = 0x83
  }

  /**
   * Emit `<key, typed_wrapper>` for a single attribute. Returns true on a
   * supported type, false (with a memoized debug log) otherwise.
   *
   * @param {MsgpackChunk} bytes
   * @param {string} key
   * @param {unknown} value
   * @returns {boolean}
   */
  #emitAttribute (bytes, key, value) {
    if (typeof value === 'string') {
      this._encodeString(bytes, key)
      bytes.set(ATTR_PREFIX_STRING)
      this._encodeString(bytes, value)
      return true
    }
    if (typeof value === 'number') {
      this._encodeString(bytes, key)
      bytes.set(Number.isInteger(value) ? ATTR_PREFIX_INT : ATTR_PREFIX_DOUBLE)
      bytes.writeIntOrFloat(value)
      return true
    }
    if (typeof value === 'boolean') {
      this._encodeString(bytes, key)
      bytes.set(value ? ATTR_PAYLOAD_BOOL_TRUE : ATTR_PAYLOAD_BOOL_FALSE)
      return true
    }
    if (Array.isArray(value)) {
      return this.#emitArrayAttribute(bytes, key, value)
    }
    memoizedLogDebug(
      key,
      'Encountered unsupported data type for span event v0.4 encoding, key: ' +
        '%s: with value: %s. Skipping encoding of pair.',
      value
    )
    return false
  }

  /**
   * Emit `<key, { type: 4, array_value: { values: [...] } }>` from a raw
   * array of primitives. Filters nested arrays / unsupported items; if no
   * items remain the whole entry is rewound.
   *
   * @param {MsgpackChunk} bytes
   * @param {string} key
   * @param {Array<unknown>} array
   * @returns {boolean}
   */
  #emitArrayAttribute (bytes, key, array) {
    const sectionStart = bytes.length

    this._encodeString(bytes, key)
    bytes.set(ATTR_PREFIX_ARRAY)
    const arrayCountOffset = bytes.length
    bytes.reserve(4)

    let count = 0
    for (const item of array) {
      if (this.#emitArrayItem(bytes, key, item)) count++
    }

    if (count === 0) {
      bytes.length = sectionStart
      return false
    }

    const target = bytes.buffer
    target[arrayCountOffset] = count >>> 24
    target[arrayCountOffset + 1] = count >>> 16
    target[arrayCountOffset + 2] = count >>> 8
    target[arrayCountOffset + 3] = count
    return true
  }

  /**
   * Emit a single typed wrapper inside an `array_value.values` array. No
   * recursion: nested arrays are dropped with a memoized debug log.
   *
   * @param {MsgpackChunk} bytes
   * @param {string} key
   * @param {unknown} value
   * @returns {boolean}
   */
  #emitArrayItem (bytes, key, value) {
    if (typeof value === 'string') {
      bytes.set(ATTR_PREFIX_STRING)
      this._encodeString(bytes, value)
      return true
    }
    if (typeof value === 'number') {
      bytes.set(Number.isInteger(value) ? ATTR_PREFIX_INT : ATTR_PREFIX_DOUBLE)
      bytes.writeIntOrFloat(value)
      return true
    }
    if (typeof value === 'boolean') {
      bytes.set(value ? ATTR_PAYLOAD_BOOL_TRUE : ATTR_PAYLOAD_BOOL_FALSE)
      return true
    }
    if (Array.isArray(value)) {
      memoizedLogDebug(
        key,
        'Encountered nested array data type for span event v0.4 encoding. ' +
          'Skipping encoding key: %s: with value: %s.',
        value
      )
    }
    return false
  }
}

const seenKeys = new Set()
function memoizedLogDebug (key, message, value) {
  if (!seenKeys.has(key)) {
    seenKeys.add(key)
    log.debug(message, key, typeof value)
  }
}

module.exports = { AgentEncoder, stringifySpanEvents }
