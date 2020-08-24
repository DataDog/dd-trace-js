'use strict'

const util = require('./util')
const tokens = require('./tokens')
const cachedString = require('./cache')(1024)
const EncoderState = require('./encoder-state')

const ARRAY_OF_TWO_THINGS = Buffer.from([0x92])

let state

let strings
let stringMap
let stringMapLen
let stringsBufLen

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
  if (text in stringMap) {
    return stringMap[text]
  }

  const id = stringMapLen++
  stringMap[text] = id
  const stringBuf = cachedString(text)
  strings.set(stringBuf, stringsBufLen)
  stringsBufLen += stringBuf.length
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
    offset = state.checkOffset(offset, 9, stringsBufLen)
    state.buffer.writeUInt8(0xcb, offset)
    state.buffer.writeDoubleBE(val, offset + 1)
    return offset + 9
  }
}

function makePayload (traceData) {
  const stringsBuf = strings.slice(0, stringsBufLen)
  const stringsLen = Reflect.ownKeys(stringMap).length
  stringsBuf.writeUInt16BE(stringsLen, 1)
  return [Buffer.concat([ARRAY_OF_TWO_THINGS, stringsBuf, traceData[0]])]
}

function init () {
  strings = Buffer.allocUnsafe(EncoderState.MAX_SIZE)
  stringMap = {}
  stringMapLen = 0
  stringsBufLen = 3 // 0xdc and then uint16
  strings[0] = 0xdc
}

module.exports = { encode, makePayload, init }
