'use strict'
const { truncateSpan, normalizeSpan } = require('./tags-processors')
const Chunk = require('./chunk')
const { AgentEncoder } = require('./0.4')

const ENCODING_VERSION = 1

function formatSpan (span) {
  return {
    type: span.type === 'test' ? 'test' : 'span',
    version: ENCODING_VERSION,
    content: normalizeSpan(truncateSpan(span))
  }
}

class AgentlessCiVisibilityEncoder extends AgentEncoder {
  constructor ({ runtimeId, service, env }) {
    super(...arguments)
    this._events = []
    this.runtimeId = runtimeId
    this.service = service
    this.env = env
    this._traceBytes = new Chunk()
    this._stringBytes = new Chunk()
    this._stringCount = 0
    this._stringMap = {}

    // Used to keep track of the number of encoded events to update the
    // length of `payload.events` when calling `makePayload`
    this._eventCount = 0

    this.reset()
  }

  _encodeEventContent (bytes, content) {
    this._encodeMapPrefix(bytes, content)
    if (content.type) {
      this._encodeString(bytes, 'type')
      this._encodeString(bytes, content.type)
    }
    this._encodeString(bytes, 'trace_id')
    this._encodeId(bytes, content.trace_id)
    this._encodeString(bytes, 'span_id')
    this._encodeId(bytes, content.span_id)
    this._encodeString(bytes, 'parent_id')
    this._encodeId(bytes, content.parent_id)
    this._encodeString(bytes, 'name')
    this._encodeString(bytes, content.name)
    this._encodeString(bytes, 'resource')
    this._encodeString(bytes, content.resource)
    this._encodeString(bytes, 'service')
    this._encodeString(bytes, content.service)
    this._encodeString(bytes, 'error')
    this._encodeNumber(bytes, content.error)
    this._encodeString(bytes, 'start')
    this._encodeNumber(bytes, content.start)
    this._encodeString(bytes, 'duration')
    this._encodeNumber(bytes, content.duration)
    this._encodeString(bytes, 'meta')
    this._encodeMap(bytes, content.meta)
    this._encodeString(bytes, 'metrics')
    this._encodeMap(bytes, content.metrics)
  }

  _encodeEvent (bytes, event) {
    this._encodeMapPrefix(bytes, event)
    this._encodeString(bytes, 'type')
    this._encodeString(bytes, event.type)

    this._encodeString(bytes, 'version')
    this._encodeNumber(bytes, event.version)

    this._encodeString(bytes, 'content')
    this._encodeEventContent(bytes, event.content)
  }

  _encodeNumber (bytes, value) {
    if (Math.floor(value) !== value) { // float 64
      return this._encodeFloat(bytes, value)
    }
    return this._encodeLong(bytes, value)
  }

  _encodeLong (bytes, value) {
    const isPositive = value >= 0

    const hi = isPositive ? (value / Math.pow(2, 32)) >> 0 : Math.floor(value / Math.pow(2, 32))
    const lo = value >>> 0
    const flag = isPositive ? 0xcf : 0xd3

    const buffer = bytes.buffer
    const offset = bytes.length

    // int 64
    bytes.reserve(9)
    bytes.length += 9

    buffer[offset] = flag
    buffer[offset + 1] = hi >> 24
    buffer[offset + 2] = hi >> 16
    buffer[offset + 3] = hi >> 8
    buffer[offset + 4] = hi
    buffer[offset + 5] = lo >> 24
    buffer[offset + 6] = lo >> 16
    buffer[offset + 7] = lo >> 8
    buffer[offset + 8] = lo
  }

  _encodeMapPrefix (bytes, map) {
    const keys = Object.keys(map)
    const buffer = bytes.buffer
    const offset = bytes.length

    bytes.reserve(5)
    bytes.length += 5
    buffer[offset] = 0xdf
    buffer[offset + 1] = keys.length >> 24
    buffer[offset + 2] = keys.length >> 16
    buffer[offset + 3] = keys.length >> 8
    buffer[offset + 4] = keys.length
  }

  _encode (bytes, trace) {
    this._eventCount += trace.length
    const events = trace.map(formatSpan)

    for (const event of events) {
      this._encodeEvent(bytes, event)
    }
  }

  makePayload () {
    const bytes = this._traceBytes
    const eventsOffset = this._eventsOffset
    const eventsCount = this._eventCount

    bytes.buffer[eventsOffset] = 0xdd
    bytes.buffer[eventsOffset + 1] = eventsCount >> 24
    bytes.buffer[eventsOffset + 2] = eventsCount >> 16
    bytes.buffer[eventsOffset + 3] = eventsCount >> 8
    bytes.buffer[eventsOffset + 4] = eventsCount

    const traceSize = bytes.length
    const buffer = Buffer.allocUnsafe(traceSize)

    bytes.buffer.copy(buffer, 0, 0, bytes.length)

    this.reset()

    return buffer
  }

  _encodePayloadStart (bytes) {
    // encodes the payload up to `events`. `events` will be encoded via _encode
    const payload = {
      version: ENCODING_VERSION,
      metadata: {
        '*': {
          'language': 'javascript'
        }
      },
      events: []
    }

    if (this.env) {
      payload.metadata['*'].env = this.env
    }
    if (this.runtimeId) {
      payload.metadata['*']['runtime-id'] = this.runtimeId
    }

    this._encodeMapPrefix(bytes, payload)
    this._encodeString(bytes, 'version')
    this._encodeNumber(bytes, payload.version)
    this._encodeString(bytes, 'metadata')
    this._encodeMapPrefix(bytes, payload.metadata)
    this._encodeString(bytes, '*')
    this._encodeMap(bytes, payload.metadata['*'])
    this._encodeString(bytes, 'events')
    // Get offset of the events list to update the length of the array when calling `makePayload`
    this._eventsOffset = bytes.length
    bytes.reserve(5)
    bytes.length += 5
  }

  reset () {
    this._reset()
    this._eventCount = 0
    this._encodePayloadStart(this._traceBytes)
  }
}

module.exports = { AgentlessCiVisibilityEncoder }
