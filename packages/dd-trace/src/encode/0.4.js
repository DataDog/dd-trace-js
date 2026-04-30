'use strict'

const getConfig = require('../config')
const { MsgpackChunk, MsgpackEncoder } = require('../msgpack')
const log = require('../log')
const { normalizeSpan } = require('./tags-processors')

const SOFT_LIMIT = 8 * 1024 * 1024 // 8MB

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
const KEY_SPAN_EVENTS = buildKey('span_events')
const KEY_META_STRUCT = buildKey('meta_struct')
const KEY_TRACE_ID_PREFIX = buildKeyWithPrefix('trace_id', 0xCF)
const KEY_SPAN_ID_PREFIX = buildKeyWithPrefix('span_id', 0xCF)
const KEY_PARENT_ID_PREFIX = buildKeyWithPrefix('parent_id', 0xCF)
const KEY_ERROR_PREFIX = buildKeyWithPrefix('error', 0xCE)
const KEY_START_PREFIX = buildKeyWithPrefix('start', 0xCF)
const KEY_DURATION_PREFIX = buildKeyWithPrefix('duration', 0xCF)
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

function formatSpanWithLegacyEvents (span) {
  span = normalizeSpan(span)
  if (span.span_events) {
    span.meta.events = JSON.stringify(span.span_events)
    // `= undefined` over `delete` to keep the span's hidden class — `delete`
    // would push every event-bearing span into V8 dictionary mode.
    span.span_events = undefined
  }
  return span
}

class AgentEncoder {
  #msgpack = new MsgpackEncoder()
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
      // eslint-disable-next-line eslint-rules/eslint-log-printf-style
      log.debug(() => {
        const hex = bytes.buffer.subarray(start, end).toString('hex').match(/../g).join(' ')
        return `Adding encoded trace to buffer: ${hex}`
      })
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
    this._encodeArrayPrefix(bytes, trace)

    const formatSpan = this.#formatSpan
    for (let span of trace) {
      span = formatSpan(span)

      let mapSize = 11
      if (span.type) mapSize++
      if (span.meta_struct) mapSize++
      if (span.span_events) mapSize++

      const headerOffset = bytes.length
      bytes.reserve(1)
      bytes.buffer[headerOffset] = 0x80 + mapSize

      if (span.type) {
        this.#writeKeyAndString(bytes, KEY_TYPE, span.type)
      }

      this.#writeIdField(bytes, KEY_TRACE_ID_PREFIX, span.trace_id)
      this.#writeIdField(bytes, KEY_SPAN_ID_PREFIX, span.span_id)
      this.#writeIdField(bytes, KEY_PARENT_ID_PREFIX, span.parent_id)

      this.#writeKeyAndString(bytes, KEY_NAME, span.name)
      this.#writeKeyAndString(bytes, KEY_RESOURCE, span.resource)
      this.#writeKeyAndString(bytes, KEY_SERVICE, span.service)
      this.#writeIntegerField(bytes, KEY_ERROR_PREFIX, span.error)
      this.#writeLongField(bytes, KEY_START_PREFIX, span.start)
      this.#writeLongField(bytes, KEY_DURATION_PREFIX, span.duration)

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
  }

  _reset () {
    this._traceCount = 0
    this._traceBytes.length = 0
    this._stringCount = 0
    this._stringBytes.length = 0
    this._stringMap = Object.create(null)

    this._cacheString('')
  }

  _encodeBuffer (bytes, buffer) {
    this.#msgpack.encodeBin(bytes, buffer)
  }

  _encodeBool (bytes, value) {
    this.#msgpack.encodeBoolean(bytes, value)
  }

  _encodeArrayPrefix (bytes, value) {
    this.#msgpack.encodeArrayPrefix(bytes, value)
  }

  _encodeMapPrefix (bytes, keysLength) {
    this.#msgpack.encodeMapPrefix(bytes, keysLength)
  }

  _encodeByte (bytes, value) {
    this.#msgpack.encodeByte(bytes, value)
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

  _encodeNumber (bytes, value) {
    this.#msgpack.encodeNumber(bytes, value)
  }

  _encodeInteger (bytes, value) {
    this.#msgpack.encodeInteger(bytes, value)
  }

  _encodeLong (bytes, value) {
    this.#msgpack.encodeLong(bytes, value)
  }

  // Single pass: reserve the count slot, encode entries while counting, patch the count.
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
        this.#encodeFloat(bytes, entryValue)
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
        const valueEntry = stringMap[entryValue] ?? this._cacheString(entryValue)
        const valueEntryLen = valueEntry.length
        bytes.reserve(keyEntryLen + valueEntryLen)
        const target = bytes.buffer
        target.set(keyEntry, writeOffset)
        target.set(valueEntry, writeOffset + keyEntryLen)
      } else {
        bytes.reserve(keyEntryLen + 9)
        const target = bytes.buffer
        target.set(keyEntry, writeOffset)
        const valueOffset = writeOffset + keyEntryLen
        target[valueOffset] = 0xCB
        bytes.view.setFloat64(valueOffset + 1, entryValue)
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
   * @param {MsgpackChunk} bytes
   * @param {Buffer} keyBuffer
   * @param {string} value
   */
  #writeKeyAndString (bytes, keyBuffer, value) {
    const valueEntry = this._stringMap[value] ?? this._cacheString(value)
    const keyLen = keyBuffer.length
    const valueLen = valueEntry.length
    const offset = bytes.length
    bytes.reserve(keyLen + valueLen)

    const target = bytes.buffer
    target.set(keyBuffer, offset)
    target.set(valueEntry, offset + keyLen)
  }

  /**
   * @param {MsgpackChunk} bytes
   * @param {Buffer} keyPrefix Precomputed `[key, 0xCF]`.
   * @param {{ toBuffer: () => Uint8Array | number[] }} identifier
   */
  #writeIdField (bytes, keyPrefix, identifier) {
    const idBuffer = identifier.toBuffer()
    const start = idBuffer.length - 8
    const keyPrefixLen = keyPrefix.length
    const offset = bytes.length
    bytes.reserve(keyPrefixLen + 8)

    const target = bytes.buffer
    target.set(keyPrefix, offset)

    const valueOffset = offset + keyPrefixLen
    target[valueOffset] = idBuffer[start]
    target[valueOffset + 1] = idBuffer[start + 1]
    target[valueOffset + 2] = idBuffer[start + 2]
    target[valueOffset + 3] = idBuffer[start + 3]
    target[valueOffset + 4] = idBuffer[start + 4]
    target[valueOffset + 5] = idBuffer[start + 5]
    target[valueOffset + 6] = idBuffer[start + 6]
    target[valueOffset + 7] = idBuffer[start + 7]
  }

  /**
   * @param {MsgpackChunk} bytes
   * @param {Buffer} keyPrefix Precomputed `[key, 0xCE]`.
   * @param {number} value
   */
  #writeIntegerField (bytes, keyPrefix, value) {
    const keyPrefixLen = keyPrefix.length
    const offset = bytes.length
    bytes.reserve(keyPrefixLen + 4)

    const target = bytes.buffer
    target.set(keyPrefix, offset)

    const valueOffset = offset + keyPrefixLen
    target[valueOffset] = value >> 24
    target[valueOffset + 1] = value >> 16
    target[valueOffset + 2] = value >> 8
    target[valueOffset + 3] = value
  }

  /**
   * @param {MsgpackChunk} bytes
   * @param {Buffer} keyPrefix Precomputed `[key, 0xCF]`.
   * @param {number} value Up to a 53-bit safe integer.
   */
  #writeLongField (bytes, keyPrefix, value) {
    const high = (value / 2 ** 32) >> 0
    const low = value >>> 0
    const keyPrefixLen = keyPrefix.length
    const offset = bytes.length
    bytes.reserve(keyPrefixLen + 8)

    const target = bytes.buffer
    target.set(keyPrefix, offset)

    const valueOffset = offset + keyPrefixLen
    target[valueOffset] = high >> 24
    target[valueOffset + 1] = high >> 16
    target[valueOffset + 2] = high >> 8
    target[valueOffset + 3] = high
    target[valueOffset + 4] = low >> 24
    target[valueOffset + 5] = low >> 16
    target[valueOffset + 6] = low >> 8
    target[valueOffset + 7] = low
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
        this.#encodeFloat(bytes, value)
        break
      case 'boolean':
        this._encodeBool(bytes, value)
        break
    }
  }

  #encodeFloat (bytes, value) {
    this.#msgpack.encodeFloat(bytes, value)
  }

  #encodeMetaStruct (bytes, value) {
    if (Array.isArray(value)) {
      this._encodeMapPrefix(bytes, 0)
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
      if (event === null || typeof event !== 'object') continue

      const eventHeaderOffset = bytes.length
      bytes.reserve(1)
      bytes.buffer[eventHeaderOffset] = 0x82

      bytes.set(KEY_NAME)
      this._encodeString(bytes, event.name)
      bytes.set(KEY_EVENT_TIME)
      this.#encodeFloat(bytes, event.time_unix_nano)

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
      this.#encodeFloat(bytes, value)
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
    memoizedLogDebug(key, 'Encountered unsupported data type for span event v0.4 encoding, key: ' +
      `${key}: with value: ${typeof value}. Skipping encoding of pair.`
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
      this.#encodeFloat(bytes, value)
      return true
    }
    if (typeof value === 'boolean') {
      bytes.set(value ? ATTR_PAYLOAD_BOOL_TRUE : ATTR_PAYLOAD_BOOL_FALSE)
      return true
    }
    if (Array.isArray(value)) {
      memoizedLogDebug(key, 'Encountered nested array data type for span event v0.4 encoding. ' +
        `Skipping encoding key: ${key}: with value: ${typeof value}.`
      )
    }
    return false
  }
}

const seenKeys = new Set()
function memoizedLogDebug (key, message) {
  if (!seenKeys.has(key)) {
    seenKeys.add(key)
    log.debug(message)
  }
}

module.exports = { AgentEncoder }
