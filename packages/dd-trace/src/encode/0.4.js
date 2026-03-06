'use strict'

const { MsgpackChunk, MsgpackEncoder } = require('../msgpack')
const log = require('../log')
const { isTrue } = require('../util')
const { memoize } = require('../log/utils')
const { getValueFromEnvSources } = require('../config/helper')
const { truncateSpan, normalizeSpan } = require('./tags-processors')

const SOFT_LIMIT = 8 * 1024 * 1024 // 8MB

function formatSpan (span, config) {
  span = normalizeSpan(truncateSpan(span, false))
  if (span.span_events) {
    // ensure span events are encoded as tags if agent doesn't support native top level span events
    if (config?.trace?.nativeSpanEvents) {
      formatSpanEvents(span)
    } else {
      span.meta.events = JSON.stringify(span.span_events)
      delete span.span_events
    }
  }
  return span
}

class AgentEncoder {
  constructor (writer, limit = SOFT_LIMIT) {
    this._msgpack = new MsgpackEncoder()
    this._limit = limit
    this._traceBytes = new MsgpackChunk()
    this._stringBytes = new MsgpackChunk()
    this._writer = writer
    this.#reset()
    this._debugEncoding = isTrue(getValueFromEnvSources('DD_TRACE_ENCODING_DEBUG'))
    this._config = this._writer?._config
  }

  count () {
    return this._traceCount
  }

  encode (trace) {
    const bytes = this._traceBytes
    const start = bytes.length

    this._traceCount++

    this.#encode(bytes, trace)

    const end = bytes.length

    if (this._debugEncoding) {
      // eslint-disable-next-line eslint-rules/eslint-log-printf-style
      log.debug(() => {
        const hex = bytes.buffer.subarray(start, end).toString('hex').match(/../g).join(' ')

        return `Adding encoded trace to buffer: ${hex}`
      })
    }

    // we can go over the soft limit since the agent has a 50MB hard limit
    if (this._traceBytes.length > this._limit || this._stringBytes.length > this._limit) {
      log.debug('Buffer went over soft limit, flushing')
      this._writer.flush()
    }
  }

  makePayload () {
    const traceSize = this._traceBytes.length + 5
    const buffer = Buffer.allocUnsafe(traceSize)

    this.#writeTraces(buffer)

    this.#reset()

    return buffer
  }

  reset () {
    this.#reset()
  }

  #encode (bytes, trace) {
    this.#encodeArrayPrefix(bytes, trace)

    for (let span of trace) {
      span = formatSpan(span, this._config)
      bytes.reserve(1)

      // this is the original size of the fixed map for span attributes that always exist
      let mapSize = 11

      // increment the payload map size depending on if some optional fields exist
      if (span.type) mapSize += 1
      if (span.meta_struct) mapSize += 1
      if (span.span_events) mapSize += 1

      bytes.buffer[bytes.length - 1] = 0x80 + mapSize

      if (span.type) {
        this.#encodeString(bytes, 'type')
        this.#encodeString(bytes, span.type)
      }

      this.#encodeString(bytes, 'trace_id')
      this.#encodeId(bytes, span.trace_id)
      this.#encodeString(bytes, 'span_id')
      this.#encodeId(bytes, span.span_id)
      this.#encodeString(bytes, 'parent_id')
      this.#encodeId(bytes, span.parent_id)
      this.#encodeString(bytes, 'name')
      this.#encodeString(bytes, span.name)
      this.#encodeString(bytes, 'resource')
      this.#encodeString(bytes, span.resource)
      this.#encodeString(bytes, 'service')
      this.#encodeString(bytes, span.service)
      this.#encodeString(bytes, 'error')
      this.#encodeInteger(bytes, span.error)
      this.#encodeString(bytes, 'start')
      this.#encodeLong(bytes, span.start)
      this.#encodeString(bytes, 'duration')
      this.#encodeLong(bytes, span.duration)
      this.#encodeString(bytes, 'meta')
      this.#encodeMap(bytes, span.meta)
      this.#encodeString(bytes, 'metrics')
      this.#encodeMap(bytes, span.metrics)
      if (span.span_events) {
        this.#encodeString(bytes, 'span_events')
        this.#encodeObjectAsArray(bytes, span.span_events, new Set())
      }
      if (span.meta_struct) {
        this.#encodeString(bytes, 'meta_struct')
        this.#encodeMetaStruct(bytes, span.meta_struct)
      }
    }
  }

  #reset () {
    this._traceCount = 0
    this._traceBytes.length = 0
    this._stringCount = 0
    this._stringBytes.length = 0
    this._stringMap = {}

    this.#cacheString('')
  }

  _encodeBuffer (bytes, buffer) {
    this._msgpack.encodeBin(bytes, buffer)
  }

  #encodeBool (bytes, value) {
    this._msgpack.encodeBoolean(bytes, value)
  }

  #encodeArrayPrefix (bytes, value) {
    this._msgpack.encodeArrayPrefix(bytes, value)
  }

  #encodeMapPrefix (bytes, keysLength) {
    this._msgpack.encodeMapPrefix(bytes, keysLength)
  }

  _encodeByte (bytes, value) {
    this._msgpack.encodeByte(bytes, value)
  }

  // TODO: Use BigInt instead.
  #encodeId (bytes, id) {
    const offset = bytes.length

    bytes.reserve(9)

    id = id.toArray()

    bytes.buffer[offset] = 0xCF
    bytes.buffer[offset + 1] = id[0]
    bytes.buffer[offset + 2] = id[1]
    bytes.buffer[offset + 3] = id[2]
    bytes.buffer[offset + 4] = id[3]
    bytes.buffer[offset + 5] = id[4]
    bytes.buffer[offset + 6] = id[5]
    bytes.buffer[offset + 7] = id[6]
    bytes.buffer[offset + 8] = id[7]
  }

  _encodeNumber (bytes, value) {
    this._msgpack.encodeNumber(bytes, value)
  }

  #encodeInteger (bytes, value) {
    this._msgpack.encodeInteger(bytes, value)
  }

  #encodeLong (bytes, value) {
    this._msgpack.encodeLong(bytes, value)
  }

  #encodeMap (bytes, value) {
    const keys = Object.keys(value)
    const validKeys = keys.filter(key => typeof value[key] === 'string' || typeof value[key] === 'number')

    this.#encodeMapPrefix(bytes, validKeys.length)

    for (const key of validKeys) {
      this.#encodeString(bytes, key)
      this.#encodeValue(bytes, value[key])
    }
  }

  #encodeValue (bytes, value) {
    switch (typeof value) {
      case 'string':
        this.#encodeString(bytes, value)
        break
      case 'number':
        this.#encodeFloat(bytes, value)
        break
      case 'boolean':
        this.#encodeBool(bytes, value)
        break
      default:
        // should not happen
    }
  }

  #encodeString (bytes, value = '') {
    this.#cacheString(value)

    const { start, end } = this._stringMap[value]

    this._stringBytes.copy(bytes, start, end)
  }

  #encodeFloat (bytes, value) {
    this._msgpack.encodeFloat(bytes, value)
  }

  #encodeMetaStruct (bytes, value) {
    const keys = Array.isArray(value) ? [] : Object.keys(value)
    const validKeys = keys.filter(key => {
      const v = value[key]
      return typeof v === 'string' ||
        typeof v === 'number' ||
        (v !== null && typeof v === 'object')
    })

    this.#encodeMapPrefix(bytes, validKeys.length)

    for (const key of validKeys) {
      const v = value[key]
      this.#encodeString(bytes, key)
      this.#encodeObjectAsByteArray(bytes, v)
    }
  }

  #encodeObjectAsByteArray (bytes, value) {
    const prefixLength = 5
    const offset = bytes.length

    bytes.reserve(prefixLength)

    this.#encodeObject(bytes, value)

    // we should do it after encoding the object to know the real length
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
    const keys = Object.keys(value)
    const validKeys = keys.filter(key => {
      const v = value[key]
      return typeof v === 'string' ||
        typeof v === 'number' || typeof v === 'boolean' ||
        (v !== null && typeof v === 'object' && !circularReferencesDetector.has(v))
    })

    this.#encodeMapPrefix(bytes, validKeys.length)

    for (const key of validKeys) {
      const v = value[key]
      this.#encodeString(bytes, key)
      this.#encodeObject(bytes, v, circularReferencesDetector)
    }
  }

  #encodeObjectAsArray (bytes, value, circularReferencesDetector) {
    const validValue = value.filter(item =>
      typeof item === 'string' ||
      typeof item === 'number' ||
      (item !== null && typeof item === 'object' && !circularReferencesDetector.has(item)))

    this.#encodeArrayPrefix(bytes, validValue)

    for (const item of validValue) {
      this.#encodeObject(bytes, item, circularReferencesDetector)
    }
  }

  #cacheString (value) {
    if (!(value in this._stringMap)) {
      this._stringCount++
      this._stringMap[value] = {
        start: this._stringBytes.length,
        end: this._stringBytes.length + this._stringBytes.write(value),
      }
    }
  }

  #writeArrayPrefix (buffer, offset, count) {
    buffer[offset++] = 0xDD
    buffer.writeUInt32BE(count, offset)

    return offset + 4
  }

  #writeTraces (buffer, offset = 0) {
    offset = this.#writeArrayPrefix(buffer, offset, this._traceCount)
    offset += this._traceBytes.buffer.copy(buffer, offset, 0, this._traceBytes.length)

    return offset
  }
}

const memoizedLogDebug = memoize((key, message) => {
  log.debug(message)
  // return something to store in memoize cache
  return true
})

function formatSpanEvents (span) {
  for (const spanEvent of span.span_events) {
    if (spanEvent.attributes) {
      let hasAttributes = false
      for (const [key, value] of Object.entries(spanEvent.attributes)) {
        const newValue = convertSpanEventAttributeValues(key, value)
        if (newValue === undefined) {
          delete spanEvent.attributes[key] // delete from attributes if undefined
        } else {
          hasAttributes = true
          spanEvent.attributes[key] = newValue
        }
      }
      if (!hasAttributes) {
        delete spanEvent.attributes
      }
    }
  }
}

function convertSpanEventAttributeValues (key, value, depth = 0) {
  if (typeof value === 'string') {
    return {
      type: 0,
      string_value: value,
    }
  }

  if (typeof value === 'boolean') {
    return {
      type: 1,
      bool_value: value,
    }
  }

  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return {
        type: 2,
        int_value: value,
      }
    }
    return {
      type: 3,
      double_value: value,
    }
  }

  if (Array.isArray(value)) {
    if (depth === 0) {
      const convertedArray = []
      for (const val of value) {
        const convertedVal = convertSpanEventAttributeValues(key, val, 1)
        if (convertedVal !== undefined) {
          convertedArray.push(convertedVal)
        }
      }

      // Only include array_value if there are valid elements
      if (convertedArray.length > 0) {
        return {
          type: 4,
          array_value: { values: convertedArray },
        }
      }
      // If all elements were unsupported, return undefined
    } else {
      memoizedLogDebug(key, 'Encountered nested array data type for span event v0.4 encoding. ' +
        `Skipping encoding key: ${key}: with value: ${typeof value}.`
      )
    }
  } else {
    memoizedLogDebug(key, 'Encountered unsupported data type for span event v0.4 encoding, key: ' +
       `${key}: with value: ${typeof value}. Skipping encoding of pair.`
    )
  }
}

module.exports = { AgentEncoder }
