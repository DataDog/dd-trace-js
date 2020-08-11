'use strict'

const util = require('./util')
const tokens = require('./tokens')
const cachedString = require('./cache')(1024)

const MAX_SIZE = 8 * 1024 * 1024 // 8MB

const zeros = {
  '4': Buffer.alloc(4),
  '8': Buffer.alloc(8)
}

let buffer
let writer
let traceOffset

function encode (initBuffer, offset, trace, initWriter) {
  traceOffset = offset
  buffer = initBuffer
  writer = initWriter
  offset = writeArrayPrefix(offset, trace)

  for (const span of trace) {
    offset = copy(offset, new Uint8Array([0b10011100])) // array of size 12
    offset = writeUint32(buffer, offset, getStringVal(span.service))
    offset = writeUint32(buffer, offset, getStringVal(span.name))
    offset = writeUint32(buffer, offset, getStringVal(span.resource))
    offset = copy(offset, tokens.uint64)
    offset = writeId(buffer, offset, span.trace_id)
    offset = copy(offset, tokens.uint64)
    offset = writeId(buffer, offset, span.span_id)
    offset = copy(offset, tokens.uint64)
    offset = writeId(buffer, offset, span.parent_id)
    offset = copy(offset, tokens.int64)
    util.writeInt64(buffer, span.start || 0, offset)
    offset += 8
    offset = copy(offset, tokens.int64)
    util.writeInt64(buffer, span.duration || 0, offset)
    offset += 8
    offset = writeInt32(buffer, offset, span.error)
    offset = writeMap(offset, span.meta || {})
    offset = writeMap(offset, span.metrics || {})
    offset = writeUint32(buffer, offset, getStringVal(span.type))
  }

  return offset
}

function getStringVal (text = '') {
  if (text in writer._stringMap) {
    return writer._stringMap[text]
  }

  const id = Reflect.ownKeys(writer._stringMap).length
  writer._stringMap[text] = id
  const stringBuf = cachedString(text)
  writer._strings.set(stringBuf, writer._stringsBufLen)
  writer._stringsBufLen += stringBuf.length
  return id
}

function checkOffset (offset, length) {
  const currentOffset = offset
  if (offset + length + writer._stringsBufLen > MAX_SIZE) {
    if (traceOffset === 5) {
      throw new RangeError('Trace is too big for payload.')
    }
    writer.flush()
    const currentBuffer = buffer
    buffer = writer._buffer
    offset = writer._offset
    offset = copy(offset, currentBuffer.slice(traceOffset, currentOffset))
  }
  return offset
}

function writeUint32 (buffer, offset, val) {
  offset = copy(offset, tokens.uint32)
  buffer.writeUInt32BE(val || zeros[4], offset)
  return offset + 4
}

function writeInt32 (buffer, offset, val) {
  offset = copy(offset, tokens.int32)
  buffer.writeInt32BE(val || zeros[4], offset)
  return offset + 4
}

function writeId (buffer, offset, id) {
  id = id ? id.toBuffer() : zeros[8]
  if (id.length > 8) {
    id = id.subarray(id.length - 8, id.length)
  }
  buffer.set(id, offset)
  return offset + 8
}

function write (offset, val) {
  if (typeof val === 'string') {
    return writeUint32(buffer, offset, getStringVal(val))
  } else { // val is number
    offset = checkOffset(offset, 9)
    buffer.writeUInt8(0xcb, offset)
    buffer.writeDoubleBE(val, offset + 1)
    return offset + 9
  }
}

function copy (offset, source) {
  const length = source.length

  offset = checkOffset(offset, length)
  buffer.set(source, offset)

  return offset + length
}

function writeMap (offset, map) {
  const keys = Object.keys(map)

  offset = copy(offset, tokens.map[keys.length])

  for (let i = 0, l = keys.length; i < l; i++) {
    offset = write(offset, keys[i])
    offset = write(offset, map[keys[i]])
  }

  return offset
}

function writePrefix (offset, length, tokens, startByte) {
  if (length <= 0xffff) {
    return copy(offset, tokens[length])
  }

  return offset + util.writeUInt8(buffer, startByte + 1, offset) + util.writeUInt32(buffer, length, offset + 1)
}

function writeArrayPrefix (offset, array) {
  return writePrefix(offset, array.length, tokens.array, 0xdc)
}

module.exports = encode
