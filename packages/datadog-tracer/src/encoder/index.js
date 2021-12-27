'use strict'

// TODO: use a different cache for low cardinality and high cardinality strings

const Chunk = require('./chunk')

const ARRAY_OF_TWO = 0x92
const ARRAY_OF_TWELVE = 0x9c
const SOFT_LIMIT = 8 * 1024 * 1024 // 8MB

const float64Array = new Float64Array(1)
const uInt8Float64Array = new Uint8Array(float64Array.buffer)

float64Array[0] = -1

const bigEndian = uInt8Float64Array[7] === 0

class Encoder {
  constructor (writer) {
    this._traceBytes = new Chunk()
    this._stringBytes = new Chunk()
    this._writer = writer
    this._reset()
  }

  count () {
    return this._traceCount
  }

  encode (spans) {
    const bytes = this._traceBytes

    this._traceCount++

    this._encode(bytes, spans)

    // we can go over the soft limit since the agent has a 50MB hard limit
    if (this._traceBytes.length > SOFT_LIMIT || this._stringBytes.length > SOFT_LIMIT) {
      this._writer.flush()
    }
  }

  makePayload () {
    const prefixSize = 1
    const stringSize = this._stringBytes.length + 5
    const traceSize = this._traceBytes.length + 5
    const buffer = Buffer.allocUnsafe(prefixSize + stringSize + traceSize)

    let offset = 0

    buffer[offset++] = ARRAY_OF_TWO

    offset = this._writeStrings(buffer, offset)
    offset = this._writeTraces(buffer, offset)

    this._reset()

    return buffer
  }

  _encode (bytes, spans) {
    this._encodeArrayPrefix(bytes, spans)

    for (const span of spans) {
      this._encodeByte(bytes, ARRAY_OF_TWELVE)
      this._encodeString(bytes, span.service)
      this._encodeString(bytes, span.name)
      this._encodeString(bytes, span.resource)
      this._encodeId(bytes, span.trace.traceId)
      this._encodeId(bytes, span.spanId)
      this._encodeId(bytes, span.parentId)
      this._encodeLong(bytes, span.start || 0)
      this._encodeLong(bytes, span.duration || 0)
      this._encodeInteger(bytes, span.error ? 1 : 0)
      this._encodeMeta(bytes, span)
      this._encodeMetrics(bytes, span)
      this._encodeString(bytes, span.type)
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

  _encodeArrayPrefix (bytes, value) {
    const length = value.length
    const buffer = bytes.buffer
    const offset = bytes.length

    bytes.reserve(5)
    bytes.length += 5

    buffer[offset] = 0xdd
    buffer[offset + 1] = length >> 24
    buffer[offset + 2] = length >> 16
    buffer[offset + 3] = length >> 8
    buffer[offset + 4] = length
  }

  _encodeByte (bytes, value) {
    const buffer = bytes.buffer

    bytes.reserve(1)

    buffer[bytes.length++] = value
  }

  _encodeId (bytes, id) {
    const buffer = bytes.buffer
    const offset = bytes.length

    bytes.reserve(9)
    bytes.length += 9

    id = id.toArray()

    buffer[offset] = 0xcf
    buffer[offset + 1] = id[0]
    buffer[offset + 2] = id[1]
    buffer[offset + 3] = id[2]
    buffer[offset + 4] = id[3]
    buffer[offset + 5] = id[4]
    buffer[offset + 6] = id[5]
    buffer[offset + 7] = id[6]
    buffer[offset + 8] = id[7]
  }

  _encodeInteger (bytes, value) {
    const buffer = bytes.buffer
    const offset = bytes.length

    bytes.reserve(5)
    bytes.length += 5

    buffer[offset] = 0xce
    buffer[offset + 1] = value >> 24
    buffer[offset + 2] = value >> 16
    buffer[offset + 3] = value >> 8
    buffer[offset + 4] = value
  }

  _encodeLong (bytes, value) {
    const buffer = bytes.buffer
    const offset = bytes.length
    const hi = (value / Math.pow(2, 32)) >> 0
    const lo = value >>> 0

    bytes.reserve(9)
    bytes.length += 9

    buffer[offset] = 0xcf
    buffer[offset + 1] = hi >> 24
    buffer[offset + 2] = hi >> 16
    buffer[offset + 3] = hi >> 8
    buffer[offset + 4] = hi
    buffer[offset + 5] = lo >> 24
    buffer[offset + 6] = lo >> 16
    buffer[offset + 7] = lo >> 8
    buffer[offset + 8] = lo
  }

  _encodeMeta (bytes, span) {
    const meta = span.meta
    const error = span.error
    const buffer = bytes.buffer
    const offset = bytes.length

    bytes.reserve(5)
    bytes.length += 5

    let length = 0

    for (const key in meta) {
      if (typeof meta[key] !== 'string' && typeof meta[key] !== 'number') continue

      length++

      this._encodeString(bytes, key)
      this._encodeString(bytes, String(meta[key]))
    }

    if (error.name) {
      length++

      this._encodeString(bytes, 'type')
      this._encodeString(bytes, error.name)
    }

    if (error.message) {
      length++

      this._encodeString(bytes, 'msg')
      this._encodeString(bytes, error.message)
    }

    if (error.stack) {
      length++

      this._encodeString(bytes, 'stack')
      this._encodeString(bytes, error.stack)
    }

    for (const key in error) {
      if (typeof error[key] !== 'string') continue

      length++

      this._encodeString(bytes, key)
      this._encodeString(bytes, meta[key])
    }

    buffer[offset] = 0xdf
    buffer[offset + 1] = length >> 24
    buffer[offset + 2] = length >> 16
    buffer[offset + 3] = length >> 8
    buffer[offset + 4] = length
  }

  _encodeMetrics (bytes, span) {
    const metrics = span.metrics
    const buffer = bytes.buffer
    const offset = bytes.length

    bytes.reserve(5)
    bytes.length += 5

    let length = 0

    for (const key in metrics) {
      if (typeof metrics[key] !== 'number') continue

      length++

      this._encodeString(bytes, key)
      this._encodeFloat(bytes, metrics[key])
    }

    buffer[offset] = 0xdf
    buffer[offset + 1] = length >> 24
    buffer[offset + 2] = length >> 16
    buffer[offset + 3] = length >> 8
    buffer[offset + 4] = length
  }

  _encodeString (bytes, value = '') {
    this._cacheString(value)
    this._encodeInteger(bytes, this._stringMap[value])
  }

  _encodeFloat (bytes, value) {
    float64Array[0] = value

    const buffer = bytes.buffer
    const offset = bytes.length

    bytes.reserve(9)
    bytes.length += 9

    buffer[offset] = 0xcb

    if (bigEndian) {
      for (let i = 0; i <= 7; i++) {
        buffer[offset + i + 1] = uInt8Float64Array[i]
      }
    } else {
      for (let i = 7; i >= 0; i--) {
        buffer[bytes.length - i - 1] = uInt8Float64Array[i]
      }
    }
  }

  _cacheString (value) {
    if (!(value in this._stringMap)) {
      this._stringMap[value] = this._stringCount++
      this._stringBytes.write(value)
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

  _writeStrings (buffer, offset) {
    offset = this._writeArrayPrefix(buffer, offset, this._stringCount)
    offset += this._stringBytes.buffer.copy(buffer, offset, 0, this._stringBytes.length)

    return offset
  }
}

module.exports = { Encoder }
