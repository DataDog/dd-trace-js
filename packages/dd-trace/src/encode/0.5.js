'use strict'

const Chunk = require('./chunk')
const log = require('../log')

const ARRAY_OF_TWO = 0x92
const ARRAY_OF_TWELVE = 0x9c
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

    this._traceCount++

    this._encode(bytes, trace)

    log.debug(() => `Adding encoded trace to buffer: ${bytes.map(b => b.toString(16)).join(' ')}`)

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

  _encode (bytes, trace) {
    this._encodeArrayPrefix(bytes, trace)

    for (const span of trace) {
      this._encodeByte(bytes, ARRAY_OF_TWELVE)
      this._encodeString(bytes, span.service)
      this._encodeString(bytes, span.name)
      this._encodeString(bytes, span.resource)
      this._encodeId(bytes, span.trace_id)
      this._encodeId(bytes, span.span_id)
      this._encodeId(bytes, span.parent_id)
      this._encodeInteger(bytes, span.start || 0)
      this._encodeInteger(bytes, span.duration || 0)
      this._encodeInteger(bytes, span.error)
      this._encodeMap(bytes, span.meta || {})
      this._encodeMap(bytes, span.metrics || {})
      this._encodeString(bytes, span.type)
    }
  }

  _reset () {
    this._traceCount = 0
    this._traceBytes.length = 0
    this._stringCount = 1
    this._stringBytes.length = 0
    this._stringBytes.push(0xa0)
    this._stringMap = { '': 0 }
  }

  _encodeArrayPrefix (bytes, value) {
    const length = value.length

    if (length < 0x10) { // fixarray
      bytes.push(length | 0x90)
    } else if (length < 0x10000) { // array 16
      bytes.push(0xdc, length >> 8, length)
    } else if (length < 0x100000000) { // array 32
      bytes.push(0xdd, length >> 24, length >> 16, length >> 8, length)
    } else {
      throw new Error('Array too large')
    }
  }

  _encodeByte (bytes, value) {
    bytes.push(value)
  }

  _encodeId (bytes, id) {
    id = id.toArray()
    bytes.push(0xcf, id[0], id[1], id[2], id[3], id[4], id[5], id[6], id[7])
  }

  _encodeInteger (bytes, value) {
    if (value < 0x80) { // positive fixnum
      bytes.push(value)
    } else if (value < 0x100) { // uint 8
      bytes.push(0xcc, value)
    } else if (value < 0x10000) { // uint 16
      bytes.push(0xcd, value >> 8, value)
    } else if (value < 0x100000000) { // uint 32
      bytes.push(0xce, value >> 24, value >> 16, value >> 8, value)
    } else {
      this._encodeBigInt(bytes, value)
    }
  }

  _encodeBigInt (bytes, value) {
    const hi = (value / Math.pow(2, 32)) >> 0
    const lo = value >>> 0

    bytes.push(0xcf, hi >> 24, hi >> 16, hi >> 8, hi, lo >> 24, lo >> 16, lo >> 8, lo)
  }

  _encodeMap (bytes, value) {
    const keys = []
    const allKeys = Object.keys(value)

    let key = ''

    for (let i = 0, l = allKeys.length; i < l; i++) {
      key = allKeys[i]
      if (typeof value[key] !== 'function') {
        keys.push(key)
      }
    }

    const length = keys.length

    if (length < 0x10) { // fixmap
      bytes.push(length | 0x80)
    } else if (length < 0x10000) { // map 16
      bytes.push(0xde, length >> 8, length)
    } else if (length < 0x100000000) { // map 32
      bytes.push(0xdf, length >> 24, length >> 16, length >> 8, length)
    } else {
      throw new Error('Object too large')
    }

    for (let i = 0; i < length; i++) {
      key = keys[i]
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
    if (!(value in this._stringMap)) {
      this._stringMap[value] = this._stringCount++
      this._stringBytes.write(value)
    }

    this._encodeInteger(bytes, this._stringMap[value])
  }

  _encodeFloat (bytes, value) {
    float64Array[0] = value

    bytes.push(0xcb)

    if (bigEndian) {
      for (let i = 0; i <= 7; i++) {
        bytes.push(uInt8Float64Array[i])
      }
    } else {
      for (let i = 7; i >= 0; i--) {
        bytes.push(uInt8Float64Array[i])
      }
    }
  }

  _writeArrayPrefix (buffer, offset, count) {
    buffer[offset++] = 0xdd
    buffer.writeUInt32BE(count, offset)

    return offset + 4
  }

  _writeStrings (buffer, offset) {
    offset = this._writeArrayPrefix(buffer, offset, this._stringCount)
    offset += this._stringBytes.buffer.copy(buffer, offset, 0, this._stringBytes.length)

    return offset
  }

  _writeTraces (buffer, offset) {
    offset = this._writeArrayPrefix(buffer, offset, this._traceCount)
    offset += this._traceBytes.buffer.copy(buffer, offset, 0, this._traceBytes.length)

    return offset
  }
}

module.exports = { AgentEncoder }
