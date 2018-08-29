'use strict'

const Uint64BE = require('int64-buffer').Uint64BE
const Buffer = require('safe-buffer').Buffer
const util = require('./util')
const tokens = require('./tokens')
const cache = require('./cache')

const values = {}
const fields = getFields()
const name = cache(1000)
const type = cache(1000)
const service = cache(1000)
const resource = cache(1000)
const key = cache(1000)

function encode (buffer, offset, trace) {
  offset = writeArrayPrefix(buffer, offset, trace)

  trace.forEach(span => {
    let fieldCount = 9

    span.parent_id && fieldCount++
    span.type && fieldCount++

    offset += tokens.map[fieldCount].copy(buffer, offset)

    offset += fields.trace_id.copy(buffer, offset)
    offset += tokens.uint64.copy(buffer, offset)
    offset += span.trace_id.buffer.copy(buffer, offset)

    offset += fields.span_id.copy(buffer, offset)
    offset += tokens.uint64.copy(buffer, offset)
    offset += span.span_id.buffer.copy(buffer, offset)

    if (span.parent_id) {
      offset += fields.parent_id.copy(buffer, offset)
      offset += tokens.uint64.copy(buffer, offset)
      offset += span.parent_id.buffer.copy(buffer, offset)
    }

    offset += fields.name.copy(buffer, offset)
    offset += name(span.name).copy(buffer, offset)

    offset += fields.resource.copy(buffer, offset)
    offset += resource(span.resource).copy(buffer, offset)

    offset += fields.service.copy(buffer, offset)
    offset += service(span.service).copy(buffer, offset)

    if (span.type) {
      offset += fields.type.copy(buffer, offset)
      offset += type(span.type).copy(buffer, offset)
    }

    offset += fields.error.copy(buffer, offset)
    offset += tokens.int[span.error].copy(buffer, offset)

    offset += fields.meta.copy(buffer, offset)
    offset = writeMap(buffer, offset, span.meta)

    offset += fields.start.copy(buffer, offset)
    offset += tokens.uint64.copy(buffer, offset)
    new Uint64BE(buffer, offset, span.start) // eslint-disable-line no-new
    offset = offset + 8

    offset += fields.duration.copy(buffer, offset)
    offset += tokens.uint64.copy(buffer, offset)
    new Uint64BE(buffer, offset, span.duration) // eslint-disable-line no-new
    offset = offset + 8
  })

  buffer.write('', offset) // throw if offset is out of bounds

  return offset
}

function value (key) {
  if (values[key] === undefined) {
    values[key] = cache(1000)
  }

  return values[key]
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

function writeMap (buffer, offset, map) {
  const keys = Object.keys(map)

  offset += tokens.map[keys.length].copy(buffer, offset)

  for (let i = 0, l = keys.length; i < l; i++) {
    offset += key(keys[i]).copy(buffer, offset)
    offset += value(keys[i])(map[keys[i]]).copy(buffer, offset)
  }

  return offset
}

function writePrefix (buffer, offset, length, tokens, startByte) {
  if (length <= 0xffff) {
    offset += tokens[length].copy(buffer, offset)
  } else {
    offset += util.writeUInt8(buffer, startByte + 1, offset)
    offset += util.writeUInt32(buffer, length, offset)
  }

  return offset
}

function writeArrayPrefix (buffer, offset, array) {
  return writePrefix(buffer, offset, array.length, tokens.array, 0xdc)
}

module.exports = encode
