'use strict'

const { truncateSpan, normalizeSpan } = require('./tags-processors')
const { Chunk, MsgpackEncoder } = require('../msgpack')
const log = require('../log')
const { isTrue } = require('../util')
const coalesce = require('koalas')

const SOFT_LIMIT = 8 * 1024 * 1024 // 8MB

function formatSpan (span) {
  return normalizeSpan(truncateSpan(span, false))
}

class AgentEncoder {
  constructor (writer, limit = SOFT_LIMIT) {
    this._msgpack = new MsgpackEncoder()
    this._limit = limit
    this._traceBytes = new Chunk()
    this._stringBytes = new Chunk()
    this._writer = writer
    this._reset()
    this._debugEncoding = isTrue(coalesce(
      process.env.DD_TRACE_ENCODING_DEBUG,
      false
    ))
  }

  count () {
    return this._traceCount
  }

  encode (trace) {
    const bytes = this._traceBytes
    const start = bytes.length

    this._traceCount++

    this._encode(bytes, trace)

    const end = bytes.length

    if (this._debugEncoding) {
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

    this._writeTraces(buffer)

    this._reset()

    return buffer
  }

  reset () {
    this._reset()
  }

  _encode (bytes, trace) {
    this._encodeArrayPrefix(bytes, trace)

    for (let span of trace) {
      span = formatSpan(span)
      bytes.reserve(1)

      if (span.type && span.meta_struct) {
        bytes.buffer[bytes.length - 1] = 0x8d
      } else if (span.type || span.meta_struct) {
        bytes.buffer[bytes.length - 1] = 0x8c
      } else {
        bytes.buffer[bytes.length - 1] = 0x8b
      }

      if (span.type) {
        this._encodeString(bytes, 'type')
        this._encodeString(bytes, span.type)
      }

      this._encodeString(bytes, 'trace_id')
      this._encodeId(bytes, span.trace_id)
      this._encodeString(bytes, 'span_id')
      this._encodeId(bytes, span.span_id)
      this._encodeString(bytes, 'parent_id')
      this._encodeId(bytes, span.parent_id)
      this._encodeString(bytes, 'name')
      this._encodeString(bytes, span.name)
      this._encodeString(bytes, 'resource')
      this._encodeString(bytes, span.resource)
      this._encodeString(bytes, 'service')
      this._encodeString(bytes, span.service)
      this._encodeString(bytes, 'error')
      this._encodeInteger(bytes, span.error)
      this._encodeString(bytes, 'start')
      this._encodeLong(bytes, span.start)
      this._encodeString(bytes, 'duration')
      this._encodeLong(bytes, span.duration)
      this._encodeString(bytes, 'meta')
      this._encodeMap(bytes, span.meta)
      this._encodeString(bytes, 'metrics')
      this._encodeMap(bytes, span.metrics)
      if (span.meta_struct) {
        this._encodeString(bytes, 'meta_struct')
        this._encodeMetaStruct(bytes, span.meta_struct)
      }
    }
  }

  _reset () {
    this._traceCount = 0
    this._traceBytes.length = 0
    this._stringCount = 0
    this._stringBytes.length = 0
    this._stringMap = {}

    this._cacheString('')
  }

  _encodeBuffer (bytes, buffer) {
    this._msgpack.encodeBin(bytes, buffer)
  }

  _encodeBool (bytes, value) {
    this._msgpack.encodeBoolean(bytes, value)
  }

  _encodeArrayPrefix (bytes, value) {
    this._msgpack.encodeArrayPrefix(bytes, value)
  }

  _encodeMapPrefix (bytes, keysLength) {
    this._msgpack.encodeMapPrefix(bytes, keysLength)
  }

  _encodeByte (bytes, value) {
    this._msgpack.encodeByte(bytes, value)
  }

  // TODO: Use BigInt instead.
  _encodeId (bytes, id) {
    const offset = bytes.length

    bytes.reserve(9)

    id = id.toArray()

    bytes.buffer[offset] = 0xcf
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

  _encodeInteger (bytes, value) {
    this._msgpack.encodeInteger(bytes, value)
  }

  _encodeLong (bytes, value) {
    this._msgpack.encodeLong(bytes, value)
  }

  _encodeMap (bytes, value) {
    const keys = Object.keys(value)
    const validKeys = keys.filter(key => typeof value[key] === 'string' || typeof value[key] === 'number')

    this._encodeMapPrefix(bytes, validKeys.length)

    for (const key of validKeys) {
      this._encodeString(bytes, key)
      this._encodeValue(bytes, value[key])
    }
  }

  _encodeValue (bytes, value) {
    switch (typeof value) {
      case 'string':
        this._encodeString(bytes, value)
        break
      case 'number':
        this._encodeFloat(bytes, value)
        break
      default:
        // should not happen
    }
  }

  _encodeString (bytes, value = '') {
    this._cacheString(value)

    const { start, end } = this._stringMap[value]

    this._stringBytes.copy(bytes, start, end)
  }

  _encodeFloat (bytes, value) {
    this._msgpack.encodeFloat(bytes, value)
  }

  _encodeMetaStruct (bytes, value) {
    const keys = Array.isArray(value) ? [] : Object.keys(value)
    const validKeys = keys.filter(key => {
      const v = value[key]
      return typeof v === 'string' ||
        typeof v === 'number' ||
        (v !== null && typeof v === 'object')
    })

    this._encodeMapPrefix(bytes, validKeys.length)

    for (const key of validKeys) {
      const v = value[key]
      this._encodeString(bytes, key)
      this._encodeObjectAsByteArray(bytes, v)
    }
  }

  _encodeObjectAsByteArray (bytes, value) {
    const prefixLength = 5
    const offset = bytes.length

    bytes.reserve(prefixLength)

    this._encodeObject(bytes, value)

    // we should do it after encoding the object to know the real length
    const length = bytes.length - offset - prefixLength
    bytes.buffer[offset] = 0xc6
    bytes.buffer[offset + 1] = length >> 24
    bytes.buffer[offset + 2] = length >> 16
    bytes.buffer[offset + 3] = length >> 8
    bytes.buffer[offset + 4] = length
  }

  _encodeObject (bytes, value, circularReferencesDetector = new Set()) {
    circularReferencesDetector.add(value)
    if (Array.isArray(value)) {
      this._encodeObjectAsArray(bytes, value, circularReferencesDetector)
    } else if (value !== null && typeof value === 'object') {
      this._encodeObjectAsMap(bytes, value, circularReferencesDetector)
    } else if (typeof value === 'string' || typeof value === 'number') {
      this._encodeValue(bytes, value)
    }
  }

  _encodeObjectAsMap (bytes, value, circularReferencesDetector) {
    const keys = Object.keys(value)
    const validKeys = keys.filter(key => {
      const v = value[key]
      return typeof v === 'string' ||
        typeof v === 'number' ||
        (v !== null && typeof v === 'object' && !circularReferencesDetector.has(v))
    })

    this._encodeMapPrefix(bytes, validKeys.length)

    for (const key of validKeys) {
      const v = value[key]
      this._encodeString(bytes, key)
      this._encodeObject(bytes, v, circularReferencesDetector)
    }
  }

  _encodeObjectAsArray (bytes, value, circularReferencesDetector) {
    const validValue = value.filter(item =>
      typeof item === 'string' ||
      typeof item === 'number' ||
      (item !== null && typeof item === 'object' && !circularReferencesDetector.has(item)))

    this._encodeArrayPrefix(bytes, validValue)

    for (const item of validValue) {
      this._encodeObject(bytes, item, circularReferencesDetector)
    }
  }

  _cacheString (value) {
    if (!(value in this._stringMap)) {
      this._stringCount++
      this._stringMap[value] = {
        start: this._stringBytes.length,
        end: this._stringBytes.length + this._stringBytes.write(value)
      }
    }
  }

  _writeArrayPrefix (buffer, offset, count) {
    buffer[offset++] = 0xdd
    buffer.writeUInt32BE(count, offset)

    return offset + 4
  }

  _writeTraces (buffer, offset = 0) {
    offset = this._writeArrayPrefix(buffer, offset, this._traceCount)
    offset += this._traceBytes.buffer.copy(buffer, offset, 0, this._traceBytes.length)

    return offset
  }
}

module.exports = { AgentEncoder }
