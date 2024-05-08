'use strict'

const collector = globalThis.__dd_collector
const Chunk = require('../../../../packages/dd-trace/src/encode/chunk')
const { zeroId } = require('../id')
const { format } = require('url')
const tracerVersion = require('../../../../package.json').version

const SOFT_LIMIT = 8 * 1024 * 1024 // 8MB

const { DD_TRACE_COLLECTOR_DEBUG } = process.env

const eventTypes = {
  RESET: 0,
  PROCESS_INFO: 129,
  START_SEGMENT: 130,
  START_SPAN: 131,
  FINISH_SPAN: 132,
  ADD_TAGS: 133,
  SAMPLING_PRIORITY: 135,
  EXCEPTION: 136,
  ADD_LINKS: 137,
  ERROR: 138,
  FINISH_SEGMENT: 139,
  CONFIG: 140,
  DISCARD_SEGMENT: 141
}

const float64Array = new Float64Array(1)
const uInt8Float64Array = new Uint8Array(float64Array.buffer)

float64Array[0] = -1

const bigEndian = uInt8Float64Array[7] === 0

class Encoder {
  constructor (config) {
    const { url, hostname, port, limit = SOFT_LIMIT, flushInterval } = config

    this._flushInterval = flushInterval
    this._limit = limit
    this._metadataBytes = new Chunk(1024)
    this._eventBytes = new Chunk()
    this._segmentBytes = new Chunk(64 * 1024)
    this._stringBytes = new Chunk()
    this._reset()

    this.encodeProcessInfo()

    this.setUrl(url || new URL(format({
      protocol: 'http:',
      hostname: hostname || 'localhost',
      port
    })))

    process.once('beforeExit', () => this.flush())
  }

  count () {
    return this._eventCount
  }

  setUrl (url) {
    const host = new URL(url).origin // TODO: Rename and cleanup.

    this.encodeConfig({ host })
  }

  encodeReset () {
    this._encodeUnsigned(this._eventBytes, eventTypes.RESET)
  }

  encodeConfig (options) {
    const bytes = this._eventBytes

    this._encodeUnsigned(bytes, eventTypes.CONFIG)
    this._encodeMap(bytes, options)
  }

  encodeProcessInfo () {
    const bytes = this._eventBytes

    this._encodeUnsigned(bytes, eventTypes.PROCESS_INFO)
    this._encodeMap(bytes, {
      tracer_version: tracerVersion,
      language: 'nodejs',
      language_interpreter: process.jsEngine || 'v8',
      language_version: process.version
    })
  }

  encodeSegmentStart (event) {
    const bytes = this._eventBytes

    this._beforeEncode(eventTypes.START_SEGMENT, event)

    this._encodeUnsigned(bytes, eventTypes.START_SEGMENT)
    this._encodeFixArray(bytes, 4)
    this._encodeTime(bytes, event.time)
    this._encodeId(bytes, event.traceId)
    this._encodeSegmentId(bytes, event.segmentId)
    this._encodeId(bytes, event.parentId)

    this._afterEncode()
  }

  encodeSegmentDiscard (event) {
    const bytes = this._eventBytes

    this._beforeEncode(eventTypes.START_SEGMENT, event)

    this._encodeUnsigned(bytes, eventTypes.DISCARD_SEGMENT)
    this._encodeFixArray(bytes, 1)
    this._encodeSegmentId(bytes, event.segmentId)

    this._afterEncode()
  }

  encodeSpanStart (event) {
    const bytes = this._eventBytes

    this._beforeEncode(eventTypes.START_SPAN, event)

    this._encodeUnsigned(bytes, eventTypes.START_SPAN)
    this._encodeFixArray(bytes, 10)
    this._encodeTime(bytes, event.ticks)
    this._encodeSegmentId(bytes, event.segmentId)
    this._encodeId(bytes, event.spanId)
    this._encodeUnsigned(bytes, event.parentIndex)
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

    this._beforeEncode(eventTypes.FINISH_SPAN, event)

    this._encodeUnsigned(bytes, eventTypes.FINISH_SPAN)
    this._encodeFixArray(bytes, 3)
    this._encodeTime(bytes, event.ticks)
    this._encodeSegmentId(bytes, event.segmentId)
    this._encodeUnsigned(bytes, event.spanIndex)

    this._afterEncode()
  }

  encodeAddTags (event) {
    const bytes = this._eventBytes

    this._beforeEncode(eventTypes.ADD_TAGS, event)

    this._encodeUnsigned(bytes, eventTypes.ADD_TAGS)
    this._encodeFixArray(bytes, 4)
    this._encodeSegmentId(bytes, event.segmentId)
    this._encodeUnsigned(bytes, event.spanIndex)
    this._encodeMeta(bytes, event.meta)
    this._encodeMetrics(bytes, event.metrics)

    this._afterEncode()
  }

  encodeException (event) {
    const bytes = this._eventBytes

    this._beforeEncode(eventTypes.EXCEPTION, event)

    this._encodeUnsigned(bytes, eventTypes.EXCEPTION)
    this._encodeFixArray(bytes, 5)
    this._encodeSegmentId(bytes, event.segmentId)
    this._encodeUnsigned(bytes, event.spanIndex)
    this._encodeString(bytes, event.error.message || '')
    this._encodeString(bytes, event.error.name || '')
    this._encodeString(bytes, event.error.stack || '')

    this._afterEncode()
  }

  makePayload () {
    const stringSize = this._stringBytes.length + 6
    const segmentSize = this._segmentBytes.length + 6
    const eventSize = this._eventBytes.length
    const buffer = Buffer.allocUnsafe(stringSize + segmentSize + eventSize)

    let offset = 0

    offset = this._writeStrings(buffer, offset)
    offset = this._writeSegments(buffer, offset)
    this._writeEvents(buffer, offset)

    this._reset()

    return buffer
  }

  flush (done = () => {}) {
    try {
      const data = this.makePayload()

      this._timer = clearTimeout(this._timer)

      collector.send_events(data)

      done()
    } catch (e) {
      done(e)
    }
  }

  reset () {
    this._reset()
  }

  _beforeEncode (type, event) {
    if (DD_TRACE_COLLECTOR_DEBUG === 'true') {
      const name = Object.keys(eventTypes).find(key => eventTypes[key] === type)

      console.log(name, type, JSON.stringify(event)) // eslint-disable-line no-console

      this._eventOffset = this._eventBytes.length
      this._stringOffset = this._stringBytes.length
      this._segmentOffset = this._segmentBytes.length
    }
  }

  _afterEncode () {
    if (DD_TRACE_COLLECTOR_DEBUG === 'true') {
      this._debugEncode('string', this._stringBytes, this._stringOffset)
      this._debugEncode('segment', this._segmentBytes, this._segmentOffset)
      this._debugEncode('event', this._eventBytes, this._eventOffset)
    }

    this._eventCount++

    this._maybeFlush()
  }

  _debugEncode (name, bytes, lastOffset) {
    const start = lastOffset
    const end = bytes.length

    if (start === end) return

    const hex = bytes.buffer
      .subarray(start, end).toString('hex').match(/../g).join(' ')

    console.log(`Encoded ${name}: ${hex}`) // eslint-disable-line no-console
  }

  _maybeFlush () {
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
    this._segmentCount = 0
    this._segmentBytes.length = 0
    this._segmentMap = new Map([[0, 0]])
    this._stringCount = 0
    this._stringBytes.length = 0
    this._stringMap = {
      '': 0
    }

    this.encodeReset(this._eventBytes)
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
      bytes.reserve(2)
      bytes.length += 2

      bytes.buffer[offset] = 0xc4
      bytes.buffer[offset + 1] = 0
    } else {
      const bufferLength = id._buffer.length
      const byteLength = 2 + bufferLength

      bytes.reserve(byteLength)
      bytes.length += byteLength

      bytes.buffer[offset] = 0xc4
      bytes.buffer[offset + 1] = bufferLength

      for (let i = 0; i < bufferLength; i++) {
        bytes.buffer[offset + 2 + i] = id._buffer[i]
      }
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

  _encodeTime (bytes, value) {
    this._encodeUnsigned(bytes, Math.floor(value * 1e6))
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
      this._encodeRawString(bytes, key)
      this._encodeValue(bytes, value[key])
    }
  }

  _encodeValue (bytes, value) {
    switch (typeof value) {
      case 'string':
        this._encodeRawString(bytes, value)
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

  _encodeSegmentId (bytes, value = 0) {
    this._cacheSegmentId(value)
    this._encodeUnsigned(bytes, this._segmentMap.get(value))
  }

  // TODO: Use an extension for string table instead and make this the default.
  _encodeRawString (bytes, value = '') {
    bytes.write(value)
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

  _cacheSegmentId (value) {
    if (!this._segmentMap.has(value)) {
      this._segmentMap.set(value, ++this._segmentCount)
      this._encodeUnsigned(this._segmentBytes, value)
    }
  }

  _writeArrayPrefix (buffer, offset, count) {
    buffer[offset++] = 0xdd
    buffer.writeUInt32BE(count, offset)

    return offset + 4
  }

  _writeSegments (buffer, offset) {
    buffer[offset++] = 0xfe
    offset = this._writeArrayPrefix(buffer, offset, this._segmentCount)
    offset += this._segmentBytes.buffer.copy(buffer, offset, 0, this._segmentBytes.length)

    return offset
  }

  _writeStrings (buffer, offset) {
    buffer[offset++] = 0xff
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
