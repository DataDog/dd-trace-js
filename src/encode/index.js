'use strict'

const Uint64BE = require('int64-buffer').Uint64BE
const Buffer = require('safe-buffer').Buffer
const util = require('./util')
const tokens = require('./tokens')

const fields = getFields()

function encode (buffer, offset, trace) {
  offset = writeArrayPrefix(buffer, offset, trace)

  trace.forEach(span => {
    let fieldCount = 9

    span.parent_id && fieldCount++
    span.type && fieldCount++

    offset += copy(buffer, offset, tokens.map[fieldCount])

    offset += copy(buffer, offset, fields.trace_id)
    offset += copy(buffer, offset, tokens.uint64)
    offset += copy(buffer, offset, span.trace_id.buffer)

    offset += copy(buffer, offset, fields.span_id)
    offset += copy(buffer, offset, tokens.uint64)
    offset += copy(buffer, offset, span.span_id.buffer)

    if (span.parent_id) {
      offset += copy(buffer, offset, fields.parent_id)
      offset += copy(buffer, offset, tokens.uint64)
      offset += copy(buffer, offset, span.parent_id.buffer)
    }

    offset += copy(buffer, offset, fields.name)
    offset += write(buffer, offset, span.name)

    offset += copy(buffer, offset, fields.resource)
    offset += write(buffer, offset, span.resource)

    offset += copy(buffer, offset, fields.service)
    offset += write(buffer, offset, span.service)

    if (span.type) {
      offset += copy(buffer, offset, fields.type)
      offset += write(buffer, offset, span.type)
    }

    offset += copy(buffer, offset, fields.error)
    offset += copy(buffer, offset, tokens.int[span.error])

    offset += copy(buffer, offset, fields.meta)
    offset = writeMap(buffer, offset, span.meta)

    offset += copy(buffer, offset, fields.start)
    offset += copy(buffer, offset, tokens.uint64)
    new Uint64BE(buffer, offset, span.start) // eslint-disable-line no-new
    offset = offset + 8

    offset += copy(buffer, offset, fields.duration)
    offset += copy(buffer, offset, tokens.uint64)
    new Uint64BE(buffer, offset, span.duration) // eslint-disable-line no-new
    offset = offset + 8
  })

  buffer.write('', offset) // throw if offset is out of bounds

  return offset
}

function write (buffer, offset, str) {
  const tokenLength = writeStringPrefix(buffer, offset, Buffer.byteLength(str))
  const length = util.write(buffer, str, offset + tokenLength)

  return length + tokenLength
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
    'start',
    'duration'
  ].reduce((prev, next) => {
    prev[next] = Buffer.concat([tokens.str[next.length], Buffer.from(next)])
    return prev
  }, {})
}

module.exports = encode
