'use strict'

// TODO: Get correlation IDs from the context and not from the event.

// const collector = require('../../../../../dd-trace-collector/node/index.node')
const collector = require('./index.node')
const Chunk = require('../../../../packages/dd-trace/src/encode/chunk')
const { zeroId } = require('../id')

// const service = process.env.DD_SERVICE || 'unnamed-node-app'
const SOFT_LIMIT = 8 * 1024 * 1024 // 8MB
const eventTypes = {
  WEB_REQUEST_START: 1,
  ERROR: 2,
  WEB_REQUEST_FINISH: 3,
  START_SPAN: 4,
  FINISH_SPAN: 5,
  ADD_TAGS: 6,
  STRINGS: 7,
  MYSQL_START_SPAN: 8,
  CONFIG: 9
}

const float64Array = new Float64Array(1)
const uInt8Float64Array = new Uint8Array(float64Array.buffer)

float64Array[0] = -1

const bigEndian = uInt8Float64Array[7] === 0

class Encoder {
  constructor ({ limit = SOFT_LIMIT, host, flushInterval }) {
    this._flushInterval = flushInterval
    this._limit = limit
    this._metadataBytes = new Chunk(1024)
    this._eventBytes = new Chunk()
    this._stringBytes = new Chunk()
    this._reset()

    this.setHost(host)

    collector.init()

    process.once('beforeExit', () => this.flush())
  }

  count () {
    return this._eventCount
  }

  setHost (host) {
    this.encodeConfig({ host })
  }

  encodeConfig (options) {
    const bytes = this._eventBytes

    this._encodeShort(bytes, eventTypes.CONFIG)
    this._encodeMap(bytes, options)
  }

  encodeSpanStart (event) {
    const bytes = this._eventBytes
    // const store = storage.getStore()

    // // if (!store || !store.traceContext) return

    this._encodeShort(bytes, eventTypes.START_SPAN)
    this._encodeFixArray(bytes, 10)
    this._encodeLong(bytes, event.time)
    this._encodeId(bytes, event.traceId)
    this._encodeId(bytes, event.spanId)
    this._encodeId(bytes, event.parentId)
    this._encodeString(bytes, event.service)
    this._encodeString(bytes, event.name)
    this._encodeString(bytes, event.resource)
    this._encodeMeta(bytes, event.meta)
    this._encodeMetrics(bytes, event.metrics)
    this._encodeString(bytes, event.type)

    this._afterEncode()
  }

  encodeSpanFinish (event) {
    const bytes = this._eventBytes
    // const store = storage.getStore()

    // if (!store || !store.traceContext) return

    this._encodeShort(bytes, eventTypes.FINISH_SPAN)
    this._encodeFixArray(bytes, 5)
    this._encodeLong(bytes, event.time)
    this._encodeId(bytes, event.traceId)
    this._encodeId(bytes, event.spanId)
    this._encodeMapPrefix(bytes, 0)
    this._encodeMapPrefix(bytes, 0)

    this._afterEncode()
  }

  encodeSpanTags (event) {
    const bytes = this._eventBytes
    // const store = storage.getStore()

    // if (!store || !store.traceContext) return

    // console.log(event.meta)

    this._encodeShort(bytes, eventTypes.ADD_TAGS)
    this._encodeFixArray(bytes, 5)
    this._encodeLong(bytes, 0)
    this._encodeId(bytes, event.traceId)
    this._encodeId(bytes, event.spanId)
    this._encodeMeta(bytes, event.meta)
    this._encodeMetrics(bytes, event.metrics)

    this._afterEncode()
  }

  encodeSpanError (event) {
    const bytes = this._eventBytes
    // const store = storage.getStore()

    // if (!store || !store.traceContext) return

    // console.log(event.meta)

    this._encodeShort(bytes, eventTypes.ERROR)
    this._encodeFixArray(bytes, 6)
    this._encodeLong(bytes, 0)
    this._encodeId(bytes, event.traceId)
    this._encodeId(bytes, event.spanId)
    this._encodeString(bytes, event.error.message || '')
    this._encodeString(bytes, event.error.name || '')
    this._encodeString(bytes, event.error.stack || '')

    this._afterEncode()
  }

  makePayload () {
    const stringSize = this._stringBytes.length + 6
    const eventSize = this._eventBytes.length
    const sab = new SharedArrayBuffer(stringSize + eventSize)
    const buffer = Buffer.from(sab)

    const offset = 0

    this._writeEvents(buffer, this._writeStrings(buffer, offset))

    this._reset()

    return buffer
  }

  flush (done = () => {}) {
    try {
      const data = this.makePayload()

      this._timer = clearTimeout(this._timer)

      collector.submit(data)

      done()
    } catch (e) {
      done(e)
    }
  }

  reset () {
    this._reset()
  }

  _afterEncode () {
    this._eventCount++

    // we can go over the soft limit since the agent has a 50MB hard limit
    if (this._eventBytes.length > this._limit || this._stringBytes.length > this._limit) {
      this.flush()
    } else if (!this._timer) {
      this._timer = setTimeout(() => this.flush(), this._flushInterval).unref()
    }
  }

  _reset () {
    this._metadataBytes.length = 0
    this._eventCount = 0
    this._eventBytes.length = 0
    this._stringCount = 0
    this._stringBytes.length = 0
    this._stringMap = {
      '': 0
    }
  }

  _encodeFixArray (bytes, size = 0) {
    const offset = bytes.length

    bytes.reserve(1)
    bytes.length += 1

    bytes.buffer[offset] = 0x90 + size
  }

  _encodeArrayPrefix (bytes, value) {
    const length = value.length
    const offset = bytes.length

    bytes.reserve(5)
    bytes.length += 5

    bytes.buffer[offset] = 0xdd
    bytes.buffer[offset + 1] = length >> 24
    bytes.buffer[offset + 2] = length >> 16
    bytes.buffer[offset + 3] = length >> 8
    bytes.buffer[offset + 4] = length
  }

  _encodeFixMap (bytes, size = 0) {
    const offset = bytes.length

    bytes.reserve(1)
    bytes.length += 1

    bytes.buffer[offset] = 0x80 + size
  }

  _encodeMapPrefix (bytes, keysLength) {
    const offset = bytes.length

    bytes.reserve(5)
    bytes.length += 5
    bytes.buffer[offset] = 0xdf
    bytes.buffer[offset + 1] = keysLength >> 24
    bytes.buffer[offset + 2] = keysLength >> 16
    bytes.buffer[offset + 3] = keysLength >> 8
    bytes.buffer[offset + 4] = keysLength
  }

  _encodeByte (bytes, value) {
    bytes.reserve(1)

    bytes.buffer[bytes.length++] = value
  }

  _encodeId (bytes, id) {
    const offset = bytes.length

    if (!id || id === zeroId) {
      bytes.reserve(1)
      bytes.length += 1

      bytes.buffer[offset] = 0x00
    } else {
      bytes.reserve(9)
      bytes.length += 9

      bytes.buffer[offset] = 0xcf
      bytes.buffer[offset + 1] = id._buffer[0]
      bytes.buffer[offset + 2] = id._buffer[1]
      bytes.buffer[offset + 3] = id._buffer[2]
      bytes.buffer[offset + 4] = id._buffer[3]
      bytes.buffer[offset + 5] = id._buffer[4]
      bytes.buffer[offset + 6] = id._buffer[5]
      bytes.buffer[offset + 7] = id._buffer[6]
      bytes.buffer[offset + 8] = id._buffer[7]
    }
  }

  _encodeInteger (bytes, value) {
    const offset = bytes.length

    bytes.reserve(5)
    bytes.length += 5

    bytes.buffer[offset] = 0xce
    bytes.buffer[offset + 1] = value >> 24
    bytes.buffer[offset + 2] = value >> 16
    bytes.buffer[offset + 3] = value >> 8
    bytes.buffer[offset + 4] = value
  }

  _encodeShort (bytes, value) {
    const offset = bytes.length

    bytes.reserve(3)
    bytes.length += 3

    bytes.buffer[offset] = 0xcd
    bytes.buffer[offset + 1] = value >> 8
    bytes.buffer[offset + 2] = value
  }

  _encodeLong (bytes, value) {
    const offset = bytes.length
    const hi = (value / Math.pow(2, 32)) >> 0
    const lo = value >>> 0

    bytes.reserve(9)
    bytes.length += 9

    bytes.buffer[offset] = 0xcf
    bytes.buffer[offset + 1] = hi >> 24
    bytes.buffer[offset + 2] = hi >> 16
    bytes.buffer[offset + 3] = hi >> 8
    bytes.buffer[offset + 4] = hi
    bytes.buffer[offset + 5] = lo >> 24
    bytes.buffer[offset + 6] = lo >> 16
    bytes.buffer[offset + 7] = lo >> 8
    bytes.buffer[offset + 8] = lo
  }

  _encodeUnsigned (bytes, value) {
    const offset = bytes.length

    if (value <= 0x7f) {
      bytes.reserve(1)
      bytes.length += 1

      bytes.buffer[offset] = value
    } else if (value <= 0xff) {
      bytes.reserve(2)
      bytes.length += 2

      bytes.buffer[offset] = 0xcc
      bytes.buffer[offset + 1] = value
    } else if (value <= 0xffff) {
      bytes.reserve(3)
      bytes.length += 3

      bytes.buffer[offset] = 0xcd
      bytes.buffer[offset + 1] = value >> 8
      bytes.buffer[offset + 2] = value
    } else if (value <= 0xffffffff) {
      bytes.reserve(5)
      bytes.length += 5

      bytes.buffer[offset] = 0xce
      bytes.buffer[offset + 1] = value >> 24
      bytes.buffer[offset + 2] = value >> 16
      bytes.buffer[offset + 3] = value >> 8
      bytes.buffer[offset + 4] = value
    } else {
      const hi = (value / Math.pow(2, 32)) >> 0
      const lo = value >>> 0

      bytes.reserve(9)
      bytes.length += 9

      bytes.buffer[offset] = 0xcf
      bytes.buffer[offset + 1] = hi >> 24
      bytes.buffer[offset + 2] = hi >> 16
      bytes.buffer[offset + 3] = hi >> 8
      bytes.buffer[offset + 4] = hi
      bytes.buffer[offset + 5] = lo >> 24
      bytes.buffer[offset + 6] = lo >> 16
      bytes.buffer[offset + 7] = lo >> 8
      bytes.buffer[offset + 8] = lo
    }
  }

  _encodeMeta (bytes, value = {}) {
    const keys = Object.keys(value)
    const validKeys = keys.filter(key => typeof value[key] === 'string')

    this._encodeMapPrefix(bytes, validKeys.length)

    for (const key of validKeys) {
      this._encodeString(bytes, key)
      this._encodeString(bytes, value[key])
    }
  }

  _encodeMetrics (bytes, value = {}) {
    const keys = Object.keys(value)
    const validKeys = keys.filter(key => typeof value[key] === 'number' && !isNaN(value[key]))

    this._encodeMapPrefix(bytes, validKeys.length)

    for (const key of validKeys) {
      this._encodeString(bytes, key)
      this._encodeFloat(bytes, value[key])
    }
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

  _encodeFixString (bytes, value = '') {
    this._cacheString(value)
    this._encodeUnsigned(bytes, this._stringMap[value])
  }

  _encodeString (bytes, value = '') {
    this._cacheString(value)
    this._encodeUnsigned(bytes, this._stringMap[value])
  }

  _encodeFloat (bytes, value) {
    float64Array[0] = value

    const offset = bytes.length
    bytes.reserve(9)
    bytes.length += 9

    bytes.buffer[offset] = 0xcb

    if (bigEndian) {
      for (let i = 0; i <= 7; i++) {
        bytes.buffer[offset + i + 1] = uInt8Float64Array[i]
      }
    } else {
      for (let i = 7; i >= 0; i--) {
        bytes.buffer[bytes.length - i - 1] = uInt8Float64Array[i]
      }
    }
  }

  _cacheString (value) {
    if (!(value in this._stringMap)) {
      this._stringMap[value] = ++this._stringCount
      this._stringBytes.write(value)
    }
  }

  _writeArrayPrefix (buffer, offset, count) {
    buffer[offset++] = 0xdd
    buffer.writeUInt32BE(count, offset)

    return offset + 4
  }

  _writeStrings (buffer, offset) {
    buffer[offset++] = 0x07
    offset = this._writeArrayPrefix(buffer, offset, this._stringCount)
    offset += this._stringBytes.buffer.copy(buffer, offset, 0, this._stringBytes.length)

    return offset
  }

  _writeEvents (buffer, offset = 0) {
    offset += this._eventBytes.buffer.copy(buffer, offset, 0, this._eventBytes.length)

    return offset
  }
}

module.exports = { Encoder }
