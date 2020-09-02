'use strict'

const util = require('./util')
const tokens = require('./tokens')
const EncoderState = require('./encoder-state')

let state
let stringCache

const fields = getFields()

const {
  headerBuffer,
  traceIdOffset,
  spanIdOffset,
  startOffset,
  durationOffset,
  errorOffset
} = (() => {
  const buffer = Buffer.alloc(1024)
  state = new EncoderState(buffer, 0, null, {})
  let offset = 0

  offset = state.copy(offset, fields.trace_id)
  offset = state.copy(offset, tokens.uint64)
  const traceIdOffset = offset
  offset += 8 // the uint64 will live here

  offset = state.copy(offset, fields.span_id)
  offset = state.copy(offset, tokens.uint64)
  const spanIdOffset = offset
  offset += 8 // the uint64 will live here

  offset = state.copy(offset, fields.start)
  offset = state.copy(offset, tokens.int64)
  const startOffset = offset
  offset += 8 // the int64 will live here

  offset = state.copy(offset, fields.duration)
  offset = state.copy(offset, tokens.int64)
  const durationOffset = offset
  offset += 8 // the int64 will live here

  offset = state.copy(offset, fields.error)
  const errorOffset = offset
  offset = state.copy(offset, tokens.int[0])

  return {
    headerBuffer: state.buffer.slice(0, offset),
    traceIdOffset,
    spanIdOffset,
    startOffset,
    durationOffset,
    errorOffset
  }
})()

function encode (initBuffer, offset, trace, initWriter) {
  state = new EncoderState(initBuffer, offset, trace, initWriter)
  offset = state.writeArrayPrefix(offset, trace)
  for (const span of trace) {
    let fieldCount = 9

    span.parent_id && fieldCount++
    span.type && fieldCount++
    span.metrics && fieldCount++

    offset = state.copy(offset, tokens.map[fieldCount])

    offset = copyHeader(offset, span)

    if (span.parent_id) {
      offset = state.copy(offset, fields.parent_id)
      offset = state.copy(offset, tokens.uint64)
      offset += util.writeId(state.buffer, span.parent_id, offset)
    }

    offset = state.copy(offset, fields.name)
    offset = write(offset, span.name)

    offset = state.copy(offset, fields.resource)
    offset = write(offset, span.resource)

    offset = state.copy(offset, fields.service)
    offset = write(offset, span.service)

    if (span.type) {
      offset = state.copy(offset, fields.type)
      offset = write(offset, span.type)
    }

    offset = state.copy(offset, fields.meta)
    offset = state.writeMap(offset, span.meta, write)

    if (span.metrics) {
      offset = state.copy(offset, fields.metrics)
      offset = state.writeMap(offset, span.metrics, write)
    }
  }

  return offset
}

function copyHeader (offset, span) {
  util.writeId(headerBuffer, span.trace_id, traceIdOffset)
  util.writeId(headerBuffer, span.span_id, spanIdOffset)
  util.writeInt64(headerBuffer, span.start, startOffset)
  util.writeInt64(headerBuffer, span.duration, durationOffset)
  headerBuffer.set(tokens.int[span.error], errorOffset)
  return state.copy(offset, headerBuffer)
}

function write (offset, val) {
  if (typeof val === 'string') {
    return state.copy(offset, cachedString(val))
  } else { // val is number
    offset = state.checkOffset(offset, 9)
    state.buffer.writeUInt8(0xcb, offset)
    state.buffer.writeDoubleBE(val, offset + 1)
    return offset + 9
  }
}

function getFields () {
  return [
    'trace_id',
    'span_id',
    'parent_id',
    'service',
    'resource',
    'name',
    'type',
    'error',
    'meta',
    'metrics',
    'start',
    'duration'
  ].reduce((prev, next) => {
    prev[next] = Buffer.concat([tokens.str[next.length], Buffer.from(next)])
    return prev
  }, {})
}

function cachedString (str) {
  if (stringCache[str]) {
    return stringCache[str]
  }

  const strLen = Buffer.byteLength(str, 'utf-8')
  const token = tokens.getStringPrefix(strLen)
  const prefixed = Buffer.allocUnsafe(strLen + token.length)
  prefixed.set(token)
  prefixed.write(str, token.length, 'utf-8')
  stringCache[str] = prefixed

  return prefixed
}

module.exports = {
  encode,
  makePayload: data => data,
  init: () => {
    stringCache = Object.create(null)
  }
}
