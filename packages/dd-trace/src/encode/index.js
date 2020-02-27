'use strict'

const util = require('./util')
const tokens = require('./tokens')
const cachedString = require('./cache')(1024)

const MAX_SIZE = 8 * 1024 * 1024 // 8MB

let buffer
let writer
let traceOffset

const fields = getFields()

const {
  headerBuffer,
  traceIdOffset,
  spanIdOffset,
  startOffset,
  durationOffset,
  errorOffset
} = (() => {
  buffer = Buffer.alloc(1024)
  let offset = 0

  offset = copy(offset, fields.trace_id)
  offset = copy(offset, tokens.uint64)
  const traceIdOffset = offset
  offset += 8 // the uint64 will live here

  offset = copy(offset, fields.span_id)
  offset = copy(offset, tokens.uint64)
  const spanIdOffset = offset
  offset += 8 // the uint64 will live here

  offset = copy(offset, fields.start)
  offset = copy(offset, tokens.int64)
  const startOffset = offset
  offset += 8 // the int64 will live here

  offset = copy(offset, fields.duration)
  offset = copy(offset, tokens.int64)
  const durationOffset = offset
  offset += 8 // the int64 will live here

  offset = copy(offset, fields.error)
  const errorOffset = offset
  offset = copy(offset, tokens.int[0])

  return {
    headerBuffer: buffer.slice(0, offset),
    traceIdOffset,
    spanIdOffset,
    startOffset,
    durationOffset,
    errorOffset
  }
})()

function encode (initBuffer, offset, trace, initWriter) {
  traceOffset = offset
  buffer = initBuffer
  writer = initWriter
  offset = writeArrayPrefix(offset, trace)

  for (const span of trace) {
    let fieldCount = 9

    span.parent_id && fieldCount++
    span.type && fieldCount++
    span.metrics && fieldCount++

    offset = copy(offset, tokens.map[fieldCount])

    offset = copyHeader(offset, span)

    if (span.parent_id) {
      offset = copy(offset, fields.parent_id)
      offset = copy(offset, tokens.uint64)
      offset = copy(offset, span.parent_id.toBuffer())
    }

    offset = copy(offset, fields.name)
    offset = write(offset, span.name)

    offset = copy(offset, fields.resource)
    offset = write(offset, span.resource)

    offset = copy(offset, fields.service)
    offset = write(offset, span.service)

    if (span.type) {
      offset = copy(offset, fields.type)
      offset = write(offset, span.type)
    }

    offset = copy(offset, fields.meta)
    offset = writeMap(offset, span.meta)

    if (span.metrics) {
      offset = copy(offset, fields.metrics)
      offset = writeMap(offset, span.metrics)
    }
  }

  return offset
}

function checkOffset (offset, length) {
  const currentOffset = offset
  if (offset + length > MAX_SIZE) {
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

function copyHeader (offset, span) {
  headerBuffer.set(span.trace_id.toBuffer(), traceIdOffset)
  headerBuffer.set(span.span_id.toBuffer(), spanIdOffset)
  util.writeInt64(headerBuffer, span.start, startOffset)
  util.writeInt64(headerBuffer, span.duration, durationOffset)
  headerBuffer.set(tokens.int[span.error], errorOffset)
  return copy(offset, headerBuffer)
}

function write (offset, val) {
  if (typeof val === 'string') {
    return copy(offset, cachedString(val))
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

module.exports = encode
