'use strict'

const { normalizeSpan } = require('./tags-processors')
const { AgentEncoder: BaseEncoder, stringifySpanEvents } = require('./0.4')

const ARRAY_OF_TWO = 0x92
const ARRAY_OF_TWELVE = 0x9C

function formatSpan (span) {
  span = normalizeSpan(span)
  // v0.5 has no native span_events slot; always serialize as a meta tag.
  if (span.span_events) {
    span.meta.events = stringifySpanEvents(span.span_events)
    // `= undefined` over `delete` to keep the span's hidden class.
    span.span_events = undefined
  }
  return span
}

class AgentEncoder extends BaseEncoder {
  makePayload () {
    const prefixSize = 1
    const stringSize = this._stringBytes.length + 5
    const traceSize = this._traceBytes.length + 5
    const buffer = Buffer.allocUnsafe(prefixSize + stringSize + traceSize)

    buffer[0] = ARRAY_OF_TWO

    const offset = this._writeStrings(buffer, 1)
    this._writeTraces(buffer, offset)

    this._reset()

    return buffer
  }

  _encode (bytes, trace) {
    this._encodeArrayPrefix(bytes, trace)

    for (let span of trace) {
      span = formatSpan(span)
      this._encodeByte(bytes, ARRAY_OF_TWELVE)
      this._encodeString(bytes, span.service)
      this._encodeString(bytes, span.name)
      this._encodeString(bytes, span.resource)
      this._encodeId(bytes, span.trace_id)
      this._encodeId(bytes, span.span_id)
      this._encodeId(bytes, span.parent_id)
      this._encodeLong(bytes, span.start || 0)
      this._encodeLong(bytes, span.duration || 0)
      this._encodeInteger(bytes, span.error)
      this._encodeMap(bytes, span.meta || {})
      this._encodeMap(bytes, span.metrics || {})
      this._encodeString(bytes, span.type)
    }
  }

  _encodeString (bytes, value = '') {
    let index = this._stringMap[value]
    if (index === undefined) {
      index = this._stringCount++
      this._stringMap[value] = index
      this._stringBytes.write(value)
    }
    this._encodeInteger(bytes, index)
  }

  _cacheString (value) {
    if (this._stringMap[value] === undefined) {
      this._stringMap[value] = this._stringCount++
      this._stringBytes.write(value)
    }
  }

  _writeStrings (buffer, offset) {
    offset = this._writeArrayPrefix(buffer, offset, this._stringCount)
    offset += this._stringBytes.buffer.copy(buffer, offset, 0, this._stringBytes.length)

    return offset
  }
}

module.exports = { AgentEncoder }
