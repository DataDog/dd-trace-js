'use strict'

const notepack = require('./notepack')
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
    this._writer = writer
    this._reset()
  }

  count () {
    return this._traces.length
  }

  encode (trace) {
    const bytes = []

    this._encode(bytes, trace)
    this._traces.push(bytes)
    this._traceSize += bytes.length

    log.debug(() => `Adding encoded trace to buffer: ${bytes.map(b => b.toString(16)).join(' ')}`)

    // we can go over the soft limit since the agent has a 50MB hard limit
    if (this._traceSize + this._stringSize > SOFT_LIMIT) {
      this._writer.flush()
    }
  }

  makePayload () {
    const prefixSize = 1
    const stringSize = this._stringSize + 5
    const traceSize = this._traceSize + 5
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
    this._traces = []
    this._traceSize = 0
    this._stringDefers = [{ value: '', length: 0, prefix: [0xa0] }]
    this._stringMap = { '': 0 }
    this._stringSize = 1
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
    notepack._encode(bytes, [], value)
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
      const prefix = []
      const defers = []
      const size = notepack._encode(prefix, defers, value)
      const length = defers[0].length

      this._stringSize += size
      this._stringMap[value] = this._stringDefers.length
      this._stringDefers.push({ value, length, prefix })
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

  _writeString (buffer, offset, defer) {
    for (let i = 0, l = defer.prefix.length; i < l; i++) {
      buffer[offset++] = defer.prefix[i]
    }

    if (defer.length > notepack.MICRO_OPT_LEN) {
      buffer.write(defer.value, offset, defer.length, 'utf8')
    } else {
      notepack.utf8Write(buffer, offset, defer.value)
    }

    return offset + defer.length
  }

  _writeStrings (buffer, offset) {
    offset = this._writeArrayPrefix(buffer, offset, this._stringDefers.length)

    for (const defer of this._stringDefers) {
      offset = this._writeString(buffer, offset, defer)
    }

    return offset
  }

  _writeTraces (buffer, offset) {
    offset = this._writeArrayPrefix(buffer, offset, this._traces.length)

    for (const trace of this._traces) {
      for (const byte of trace) {
        buffer[offset++] = byte
      }
    }

    return offset
  }
}

module.exports = { AgentEncoder }
