'use strict'
const tracerVersion = require('../../lib/version')
const { truncateSpan, normalizeSpan } = require('./tags-processors')
const Chunk = require('./chunk')
const log = require('../log')

const ENCODING_VERSION = 1
const float64Array = new Float64Array(1)
const uInt8Float64Array = new Uint8Array(float64Array.buffer)

float64Array[0] = -1

const bigEndian = uInt8Float64Array[7] === 0

function formatSpan (span) {
  return {
    type: span.type === 'test' ? 'test' : 'span',
    version: ENCODING_VERSION,
    content: normalizeSpan(truncateSpan(span))
  }
}

class AgentlessCiVisibilityEncoder {
  constructor ({ runtimeId, service, env }) {
    this._events = []
    this.runtimeId = runtimeId
    this.service = service
    this.env = env
    this._traceBytes = new Chunk()
    this._stringBytes = new Chunk()
    this._stringCount = 0
    this._stringMap = {}

    this.reset()
  }

  count () {
    return this._events.length
  }

  append (trace) {
    this._events = this._events.concat(trace)
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

  _encodeMap (bytes, value) {
    const keys = Object.keys(value)
    const buffer = bytes.buffer
    const offset = bytes.length

    const length = keys.length

    if (length < 0x10) { // fixmap
      bytes.reserve(1)
      bytes.length += 1
      buffer[offset] = length | 0x80
    } else if (length < 0x10000) { // map 16
      bytes.reserve(3)
      bytes.length += 3
      buffer[offset] = 0xde
      buffer[offset + 1] = length >> 8
      buffer[offset + 2] = length
    } else if (length < 0x100000000) { // map 32
      bytes.reserve(5)
      bytes.length += 5
      buffer[offset] = 0xdf
      buffer[offset + 1] = length >> 24
      buffer[offset + 2] = length >> 16
      buffer[offset + 3] = length >> 8
      buffer[offset + 4] = length
    }

    for (const key of keys) {
      this._encodeString(bytes, key)
      this._encodeValue(bytes, value[key])
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

  _encodeNumber (bytes, value) {
    if (Math.floor(value) !== value) { // float 64
      return this._encodeFloat(bytes, value)
    }
    return this._encodeInteger(bytes, value)
  }

  _encodeValue (bytes, value) {
    switch (typeof value) {
      case 'string':
        this._encodeString(bytes, value)
        break
      case 'number':
        this._encodeNumber(bytes, value)
        break
      case 'object':
        if (Array.isArray(value)) {
          this._encodeArrayPrefix(bytes, value)
          for (const event of value) {
            this._encodeMap(bytes, event)
          }
          return
        }
        this._encodeMap(bytes, value)
        break
      default:
        // should not happen
    }
  }

  _encodeArrayPrefix (bytes, value) {
    const length = value.length
    const buffer = bytes.buffer
    const offset = bytes.length

    if (length < 0x10) { // fixarray
      bytes.reserve(1)
      bytes.length += 1
      buffer[offset] = length | 0x90
      return
    }
    if (length < 0x10000) { // array 16
      bytes.reserve(3)
      bytes.length += 3
      buffer[offset] = 0xdc
      buffer[offset + 1] = length >> 8
      buffer[offset + 2] = length
      return
    }
    if (length < 0x100000000) { // array 32
      bytes.reserve(5)
      bytes.length += 5
      buffer[offset] = 0xdd
      buffer[offset + 1] = length >> 24
      buffer[offset + 2] = length >> 16
      buffer[offset + 3] = length >> 8
      buffer[offset + 4] = length
    }
  }

  _encodeInteger (bytes, value) {
    if (value >= 0) {
      this._encodePositiveLong(bytes, value)
    } else {
      this._encodeNegativeLong(bytes, value)
    }
  }

  _encodeNegativeLong (bytes, value) {
    const buffer = bytes.buffer
    const offset = bytes.length

    if (value >= -0x20) { // negative fixnum
      bytes.reserve(1)
      bytes.length += 1
      buffer[offset] = value
      return
    }

    if (value >= -0x80) { // int 8
      bytes.reserve(2)
      bytes.length += 2
      buffer[offset] = 0xd0
      buffer[offset + 1] = value
      return
    }

    if (value >= -0x8000) { // int 16
      bytes.reserve(3)
      bytes.length += 3
      buffer[offset] = 0xd1
      buffer[offset + 1] = value >> 8
      buffer[offset + 2] = value
      return
    }

    if (value >= -0x80000000) { // int 32
      bytes.reserve(5)
      bytes.length += 5
      buffer[offset] = 0xd2
      buffer[offset + 1] = value >> 24
      buffer[offset + 2] = value >> 16
      buffer[offset + 3] = value >> 8
      buffer[offset + 4] = value
      return
    }

    // int 64
    const hi = Math.floor(value / Math.pow(2, 32))
    const lo = value >>> 0

    bytes.reserve(9)
    bytes.length += 9

    buffer[offset] = 0xd3
    buffer[offset + 1] = hi >> 24
    buffer[offset + 2] = hi >> 16
    buffer[offset + 3] = hi >> 8
    buffer[offset + 4] = hi
    buffer[offset + 5] = lo >> 24
    buffer[offset + 6] = lo >> 16
    buffer[offset + 7] = lo >> 8
    buffer[offset + 8] = lo
  }

  _encodePositiveLong (bytes, value) {
    const buffer = bytes.buffer
    const offset = bytes.length

    if (value < 0x80) { // positive fixnum
      bytes.reserve(1)
      bytes.length += 1
      buffer[offset] = value
      return
    }

    if (value < 0x100) { // uint 8
      bytes.reserve(2)
      bytes.length += 2
      buffer[offset] = 0xcc
      buffer[offset + 1] = value
      return
    }

    if (value < 0x10000) { // uint 16
      bytes.reserve(3)
      bytes.length += 3
      buffer[offset] = 0xcd
      buffer[offset + 1] = value >> 8
      buffer[offset + 2] = value
      return
    }

    if (value < 0x100000000) { // uint 32
      bytes.reserve(5)
      bytes.length += 5
      buffer[offset] = 0xce
      buffer[offset + 1] = value >> 24
      buffer[offset + 2] = value >> 16
      buffer[offset + 3] = value >> 8
      buffer[offset + 4] = value
      return
    }

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

  _encode (bytes) {
    const payload = {
      version: ENCODING_VERSION,
      metadata: {
        'language': 'javascript',
        'library_version': tracerVersion,
        'runtime.name': 'node',
        'runtime.version': process.version
      },
      events: this._events.map(formatSpan)
    }
    if (this.service) {
      payload.metadata.service = this.service
    }
    if (this.env) {
      payload.metadata.end = this.env
    }
    if (this.runtimeId) {
      payload.metadata.runtime_id = this.runtimeId
    }

    log.debug(() => {
      return `Adding encoded trace to buffer: ${JSON.stringify(payload)}`
    })

    this._encodeMap(bytes, payload)
  }

  makePayload () {
    const bytes = this._traceBytes

    this._encode(bytes)

    const traceSize = this._traceBytes.length
    const buffer = Buffer.allocUnsafe(traceSize)

    this._traceBytes.buffer.copy(buffer, 0, 0, this._traceBytes.length)

    this.reset()

    return buffer
  }

  reset () {
    this._traceBytes.length = 0
    this._stringCount = 0
    this._stringBytes.length = 0
    this._stringMap = {}

    this._cacheString('')
    this._events = []
  }
}

module.exports = { AgentlessCiVisibilityEncoder }
