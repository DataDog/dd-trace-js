'use strict'

const Chunk = require('./chunk')
const log = require('../log')

const SOFT_LIMIT = 8 * 1024 * 1024 // 8MB

const float64Array = new Float64Array(1)
const uInt8Float64Array = new Uint8Array(float64Array.buffer)

float64Array[0] = -1

const bigEndian = uInt8Float64Array[7] === 0

class AgentEncoder {
  constructor (writer) {
    this._traceBytes = new Chunk()
    this._stringBytes = new Chunk()
    this._writer = writer
    this._reset()
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

    log.debug(() => {
      const hex = bytes.buffer.subarray(start, end).toString('hex').match(/../g).join(' ')

      return `Adding encoded trace to buffer: ${hex}`
    })

    // we can go over the soft limit since the agent has a 50MB hard limit
    if (this._traceBytes.length > SOFT_LIMIT || this._stringBytes.length > SOFT_LIMIT) {
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

    for (const span of trace) {
      bytes.reserve(1)

      if (span.type) {
        bytes.buffer[bytes.length++] = 0x8c

        this._encodeString(bytes, 'type')
        this._encodeString(bytes, span.type)
      } else {
        bytes.buffer[bytes.length++] = 0x8b
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

  _encodeMapPrefix (bytes, keysLength) {
    const buffer = bytes.buffer
    const offset = bytes.length

    bytes.reserve(5)
    bytes.length += 5
    buffer[offset] = 0xdf
    buffer[offset + 1] = keysLength >> 24
    buffer[offset + 2] = keysLength >> 16
    buffer[offset + 3] = keysLength >> 8
    buffer[offset + 4] = keysLength
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

  _encodeMap (bytes, value) {
    const keys = Object.keys(value)
    const buffer = bytes.buffer
    const offset = bytes.length

    bytes.reserve(5)
    bytes.length += 5

    let length = 0

    for (const key of keys) {
      if (typeof value[key] !== 'string' && typeof value[key] !== 'number') return
      length++

      this._encodeString(bytes, key)
      this._encodeValue(bytes, value[key])
    }

    buffer[offset] = 0xdf
    buffer[offset + 1] = length >> 24
    buffer[offset + 2] = length >> 16
    buffer[offset + 3] = length >> 8
    buffer[offset + 4] = length
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
