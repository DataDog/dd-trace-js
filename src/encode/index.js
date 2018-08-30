'use strict'

const Uint64BE = require('int64-buffer').Uint64BE
const Buffer = require('safe-buffer').Buffer
const util = require('./util')
const tokens = require('./tokens')
const temp = Buffer.alloc(8 * 1024 * 1024)

function encode (buffer, offset, trace) {
  offset = writeArrayPrefix(buffer, offset, trace)

  trace.forEach(span => {
    let fieldCount = 9

    span.parent_id && fieldCount++
    span.type && fieldCount++

    offset += copy(buffer, offset, tokens.map[fieldCount])

    offset += writeAscii(buffer, offset, 'trace_id')
    offset += copy(buffer, offset, tokens.uint64)
    offset += copy(buffer, offset, span.trace_id.buffer)

    offset += writeAscii(buffer, offset, 'span_id')
    offset += copy(buffer, offset, tokens.uint64)
    offset += copy(buffer, offset, span.span_id.buffer)

    if (span.parent_id) {
      offset += write(buffer, offset, 'parent_id')
      offset += copy(buffer, offset, tokens.uint64)
      offset += copy(buffer, offset, span.parent_id.buffer)
    }

    offset += writeAscii(buffer, offset, 'name')
    offset += write(buffer, offset, span.name)

    offset += writeAscii(buffer, offset, 'resource')
    offset += write(buffer, offset, span.resource)

    offset += writeAscii(buffer, offset, 'service')
    offset += write(buffer, offset, span.service)

    if (span.type) {
      offset += writeAscii(buffer, offset, 'type')
      offset += write(buffer, offset, span.type)
    }

    offset += writeAscii(buffer, offset, 'error')
    offset += copy(buffer, offset, tokens.int[span.error])

    offset += writeAscii(buffer, offset, 'meta')
    offset = writeMap(buffer, offset, span.meta)

    offset += writeAscii(buffer, offset, 'start')
    offset += copy(buffer, offset, tokens.uint64)
    new Uint64BE(buffer, offset, span.start) // eslint-disable-line no-new
    offset = offset + 8

    offset += writeAscii(buffer, offset, 'duration')
    offset += copy(buffer, offset, tokens.uint64)
    new Uint64BE(buffer, offset, span.duration) // eslint-disable-line no-new
    offset = offset + 8
  })

  buffer.write('', offset) // throw if offset is out of bounds

  return offset
}

function writeAscii (buffer, offset, str) {
  const length = str.length
  const written = writeStringPrefix(buffer, offset, length)

  offset += written

  for (let i = 0; i < length; i++) {
    buffer[offset + i] = str.charCodeAt(i)
  }

  return length + written
}

function write (buffer, offset, str) {
  const tokenLength = writeStringPrefix(buffer, offset, Buffer.byteLength(str))
  const length = util.write(buffer, str, offset + tokenLength)

  // copy(buffer, offset + tokenLength, temp, 0, length)

  return length + tokenLength

  // const length = util.write(temp, str)
  // const tokenLength = writeStringPrefix(buffer, offset, length)

  // copy(buffer, offset + tokenLength, temp, 0, length)

  // return length + tokenLength
}

function copy (buffer, offset, source, sourceStart, sourceEnd) {
  const length = source.length

  sourceStart = sourceStart || 0
  sourceEnd = sourceEnd || length

  for (let i = sourceStart; i < sourceEnd; i++) {
    buffer[offset + i] = source[i]
  }

  return source.length
}

function writeMap (buffer, offset, map) {
  const keys = Object.keys(map)

  offset += copy(buffer, offset, tokens.map[keys.length])

  for (let i = 0, l = keys.length; i < l; i++) {
    offset += write(buffer, offset, keys[i])
    offset += write(buffer, offset, map[keys[i]])
  }

  return offset
}

function writePrefix (buffer, offset, length, tokens, startByte) {
  if (length <= 0xffff) {
    return copy(buffer, offset, tokens[length])
  }

  return util.writeUInt8(buffer, startByte + 1, offset) + util.writeUInt32(buffer, length, offset + 1)
}

function writeStringPrefix (buffer, offset, length) {
  return writePrefix(buffer, offset, length, tokens.str, 0xda)
}

function writeArrayPrefix (buffer, offset, array) {
  return offset + writePrefix(buffer, offset, array.length, tokens.array, 0xdc)
}

module.exports = encode
