'use strict'

const Chunk = require('../../../../packages/dd-trace/src/encode/chunk')
const { storage } = require('../../../../packages/datadog-core')
const { Client } = require('./client')

const processStartTime = BigInt(Date.now() * 1e6)
const processStartTicks = process.hrtime.bigint()
const now = () => Number(processStartTime + process.hrtime.bigint() - processStartTicks)
const service = process.env.DD_SERVICE || 'unnamed-node-app'
const ARRAY_OF_TWO = 0x92
const SOFT_LIMIT = 8 * 1024 * 1024 // 8MB
const flushInterval = 2000
const noop = () => {}
const eventTypes = {
  KOA_REQUEST_START: 1,
  ERROR: 2,
  KOA_REQUEST_FINISH: 3
}

const float64Array = new Float64Array(1)
const uInt8Float64Array = new Uint8Array(float64Array.buffer)

float64Array[0] = -1

const bigEndian = uInt8Float64Array[7] === 0

class Encoder {
  constructor (limit = SOFT_LIMIT) {
    this._limit = limit
    this._metadataBytes = new Chunk(1024)
    this._eventBytes = new Chunk()
    this._stringBytes = new Chunk()
    this._client = new Client()
    this._reset()

    process.once('beforeExit', () => this.flush())
  }

  count () {
    return this._eventCount
  }

  encodeKoaRequestStart (req) {
    const bytes = this._eventBytes
    const store = storage.getStore()

    if (!store || !store.traceContext) return

    // service name comes from process
    // span name comes from event type
    // resource comes from mixing http method and route
    // error will be its own event

    this._encodeFixArray(bytes, 7)
    this._encodeShort(bytes, eventTypes.KOA_REQUEST_START) // implied: name
    this._encodeLong(bytes, now())
    this._encodeId(bytes, store.traceContext.traceId)
    this._encodeId(bytes, store.traceContext.spanId)
    this._encodeId(bytes, store.traceContext.parentId) // ???
    this._encodeString(bytes, req.method)
    this._encodeString(bytes, req.url)

    this._afterEncode()
  }

  encodeKoaRequestFinish (res) {
    const bytes = this._eventBytes
    const store = storage.getStore()

    if (!store || !store.traceContext) return

    this._encodeFixArray(bytes, 5)
    this._encodeShort(bytes, eventTypes.KOA_REQUEST_FINISH) // implied: name
    this._encodeLong(bytes, now())
    this._encodeId(bytes, store.traceContext.traceId)
    this._encodeId(bytes, store.traceContext.spanId)
    this._encodeShort(bytes, res.statusCode)

    this._afterEncode()
  }

  encodeError (error) {
    const bytes = this._eventBytes
    const store = storage.getStore()

    if (!store || !store.traceContext) return // TODO: support errors without tracing

    this._encodeFixArray(bytes, 7)
    this._encodeShort(bytes, eventTypes.ERROR) // implied: name
    this._encodeLong(bytes, now())
    this._encodeId(bytes, store.traceContext.traceId)
    this._encodeId(bytes, store.traceContext.spanId)
    this._encodeString(bytes, error.name)
    this._encodeString(bytes, error.message)
    this._encodeString(bytes, error.stack)

    this._afterEncode()
  }

  // TODO: support new payload format
  makePayload05 () {
    const prefixSize = 1
    const stringSize = this._stringBytes.length + 5
    const eventSize = this._eventBytes.length + 5
    const buffer = Buffer.allocUnsafe(prefixSize + stringSize + eventSize)

    let offset = 0

    buffer[offset++] = ARRAY_OF_TWO

    offset = this._writeStrings(buffer, offset)
    offset = this._writeEvents(buffer, offset)

    this._reset()

    return buffer
  }

  makePayload () {
    this._encodeMap(this._metadataBytes, { service }) // HACK

    const metadataBytes = this._metadataBytes
    const metadataSize = metadataBytes.length + 9
    const eventSize = this._eventBytes.length + 5 + 7
    const buffer = Buffer.allocUnsafe(1 + metadataSize + eventSize)

    let offset = 0

    buffer[offset++] = 0x82 // fixmap(2)

    buffer[offset++] = 0xa8 // fixstr(8)
    offset += buffer.write('metadata', offset)
    offset += metadataBytes.buffer.copy(buffer, offset, 0, metadataBytes.length)

    buffer[offset++] = 0xa6 // fixstr(6)
    offset += buffer.write('events', offset)
    offset = this._writeEvents(buffer, offset)

    this._reset()

    return buffer
  }

  flush (done = noop) {
    const count = this.count()

    if (count === 0) return

    const data = this.makePayload()
    const path = `/v0.1/events`

    this._timer = clearTimeout(this._timer)
    this._client.request({ data, path, count }, done)
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
      this._timer = setTimeout(() => this.flush(), flushInterval).unref()
    }
  }

  _reset () {
    this._metadataBytes.length = 0
    this._eventCount = 0
    this._eventBytes.length = 0
    this._stringCount = 0
    this._stringBytes.length = 0
    this._stringMap = {}

    this._cacheString('')
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

    bytes.reserve(9)
    bytes.length += 9

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

  _encodeString05 (bytes, value = '') {
    this._cacheString(value)
    this._encodeInteger(bytes, this._stringMap[value])
  }

  _encodeString (bytes, value = '') {
    this._cacheString(value)

    const { start, end } = this._stringMap[value]

    this._stringBytes.copy(bytes, start, end)
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

  _cacheString05 (value) {
    if (!(value in this._stringMap)) {
      this._stringMap[value] = this._stringCount++
      this._stringBytes.write(value)
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

  _writeStrings (buffer, offset) {
    offset = this._writeArrayPrefix(buffer, offset, this._stringCount)
    offset += this._stringBytes.buffer.copy(buffer, offset, 0, this._stringBytes.length)

    return offset
  }

  _writeEvents (buffer, offset = 0) {
    offset = this._writeArrayPrefix(buffer, offset, this._eventCount)
    offset += this._eventBytes.buffer.copy(buffer, offset, 0, this._eventBytes.length)

    return offset
  }
}

module.exports = { Encoder }
