'use strict'

const util = require('./util')
const tokens = require('./tokens')
const cachedString = require('./cache')(1024)
const EncoderState = require('./encoder-state')

let state

function encode (initBuffer, offset, trace, initWriter) {
  state = new EncoderState(initBuffer, offset, trace, initWriter)
  offset = state.writeArrayPrefix(offset, trace)

  for (const span of trace) {
    offset = state.copy(offset, tokens.array[12]) // array of size 12
    offset = writeUint32(offset, getTokenForString(span.service))
    offset = writeUint32(offset, getTokenForString(span.name))
    offset = writeUint32(offset, getTokenForString(span.resource))
    offset = state.copy(offset, tokens.uint64)
    offset += util.writeId(state.buffer, span.trace_id, offset)
    offset = state.copy(offset, tokens.uint64)
    offset += util.writeId(state.buffer, span.span_id, offset)
    offset = state.copy(offset, tokens.uint64)
    offset += util.writeId(state.buffer, span.parent_id, offset)
    offset = state.copy(offset, tokens.int64)
    util.writeInt64(state.buffer, span.start || 0, offset)
    offset += 8
    offset = state.copy(offset, tokens.int64)
    util.writeInt64(state.buffer, span.duration || 0, offset)
    offset += 8
    offset = writeInt32(offset, span.error)
    offset = state.writeMap(offset, span.meta || {}, write)
    offset = state.writeMap(offset, span.metrics || {}, write)
    offset = writeUint32(offset, getTokenForString(span.type))
  }

  return offset
}

function getTokenForString (text) {
  if (text in state.writer._stringMap) {
    return state.writer._stringMap[text]
  }

  const id = state.writer._stringMapLen++
  state.writer._stringMap[text] = id
  const stringBuf = cachedString(text)
  state.writer._strings.set(stringBuf, state.writer._stringsBufLen)
  state.writer._stringsBufLen += stringBuf.length
  return id
}

function writeUint32 (offset, val) {
  offset = state.copy(offset, tokens.uint32)
  offset += util.writeUInt32(state.buffer, val || 0, offset)
  return offset
}

function writeInt32 (offset, val) {
  offset = state.copy(offset, tokens.int32)
  // values here are only ever 1 and 0, so writing is equivalent t uint32
  offset += util.writeUInt32(state.buffer, val || 0, offset)
  return offset
}

function write (offset, val) {
  if (typeof val === 'string') {
    return writeUint32(offset, getTokenForString(val))
  } else { // val is number
    offset = state.checkOffset(offset, 9)
    state.buffer.writeUInt8(0xcb, offset)
    state.buffer.writeDoubleBE(val, offset + 1)
    return offset + 9
  }
}

module.exports = encode
