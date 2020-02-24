'use strict'

const { Int64BE, Uint64BE } = require('int64-buffer')
const util = require('./util')
const tokens = require('./tokens')
const cachedString = require('./cache')(1024)

const MAX_SIZE = 8 * 1024 * 1024 // 8MB

let overflow = false

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
  let offset = 0

  offset += copy(buffer, offset, fields.trace_id)
  offset += copy(buffer, offset, tokens.uint64)
  const traceIdOffset = offset
  new Uint64BE(buffer, offset, 0) // eslint-disable-line no-new
  offset += 8

  offset += copy(buffer, offset, fields.span_id)
  offset += copy(buffer, offset, tokens.uint64)
  const spanIdOffset = offset
  new Uint64BE(buffer, offset, 0) // eslint-disable-line no-new
  offset += 8

  offset += copy(buffer, offset, fields.start)
  offset += copy(buffer, offset, tokens.int64)
  const startOffset = offset
  new Int64BE(buffer, offset, 0) // eslint-disable-line no-new
  offset += 8

  offset += copy(buffer, offset, fields.duration)
  offset += copy(buffer, offset, tokens.int64)
  const durationOffset = offset
  new Int64BE(buffer, offset, 0) // eslint-disable-line no-new
  offset += 8

  offset += copy(buffer, offset, fields.error)
  const errorOffset = offset
  offset += copy(buffer, offset, tokens.int[0])

  return {
    headerBuffer: buffer.slice(0, offset),
    traceIdOffset,
    spanIdOffset,
    startOffset,
    durationOffset,
    errorOffset
  }
})()

function encode (buffer, offset, trace) {
  offset = writeArrayPrefix(buffer, offset, trace)
  if (overflow) {
    overflow = false
    return
  }

  for (const span of trace) {
    let fieldCount = 9

    span.parent_id && fieldCount++
    span.type && fieldCount++
    span.metrics && fieldCount++

    offset += copy(buffer, offset, tokens.map[fieldCount])

    offset += copyHeader(buffer, offset, span)
    if (overflow) {
      break
    }

    if (span.parent_id) {
      offset += copy(buffer, offset, fields.parent_id)
      offset += copy(buffer, offset, tokens.uint64)
      offset += copy(buffer, offset, span.parent_id.toBuffer())
      if (overflow) {
        break
      }
    }

    offset += copy(buffer, offset, fields.name)
    offset += write(buffer, offset, span.name)
    if (overflow) {
      break
    }

    offset += copy(buffer, offset, fields.resource)
    offset += write(buffer, offset, span.resource)
    if (overflow) {
      break
    }

    offset += copy(buffer, offset, fields.service)
    offset += write(buffer, offset, span.service)
    if (overflow) {
      break
    }

    if (span.type) {
      offset += copy(buffer, offset, fields.type)
      offset += write(buffer, offset, span.type)
      if (overflow) {
        break
      }
    }

    offset += copy(buffer, offset, fields.meta)
    offset = writeMap(buffer, offset, span.meta)
    if (overflow) {
      break
    }

    if (span.metrics) {
      offset += copy(buffer, offset, fields.metrics)
      offset = writeMap(buffer, offset, span.metrics)
      if (overflow) {
        break
      }
    }
  }

  if (overflow) {
    overflow = false
    offset = false
  }

  return offset
}

function copyHeader (buffer, offset, span) {
  copy(headerBuffer, traceIdOffset, span.trace_id.toBuffer())
  copy(headerBuffer, spanIdOffset, span.span_id.toBuffer())
  new Uint64BE(headerBuffer, startOffset, span.start) // eslint-disable-line no-new
  new Uint64BE(headerBuffer, durationOffset, span.duration) // eslint-disable-line no-new
  copy(headerBuffer, errorOffset, tokens.int[span.error])
  return copy(buffer, offset, headerBuffer)
}

function write (buffer, offset, val) {
  if (typeof val === 'string') {
    return copy(buffer, offset, cachedString(val))
  } else { // val is number
    if (offset + 9 > MAX_SIZE) {
      overflow = true
      return
    }
    buffer.writeUInt8(0xcb, offset)
    buffer.writeDoubleBE(val, offset + 1)
    return 9
  }
}

function copy (buffer, offset, source, sourceStart, sourceEnd) {
  const length = source.length
  if (length + offset > MAX_SIZE) {
    overflow = true
    return
  }

  sourceStart = sourceStart || 0
  sourceEnd = sourceEnd || length

  if (sourceStart !== 0 || sourceEnd !== length) {
    source = source.slice(sourceEnd, sourceEnd)
  }
  buffer.set(source, offset)

  return source.length
}

function writeMap (buffer, offset, map) {
  const keys = Object.keys(map)

  offset += copy(buffer, offset, tokens.map[keys.length])
  if (overflow) {
    return
  }

  for (let i = 0, l = keys.length; i < l; i++) {
    offset += write(buffer, offset, keys[i])
    if (overflow) {
      return
    }

    offset += write(buffer, offset, map[keys[i]])
    if (overflow) {
      return
    }
  }

  return offset
}

function writePrefix (buffer, offset, length, tokens, startByte) {
  if (length <= 0xffff) {
    return copy(buffer, offset, tokens[length])
  }

  return util.writeUInt8(buffer, startByte + 1, offset) + util.writeUInt32(buffer, length, offset + 1)
}

function writeArrayPrefix (buffer, offset, array) {
  offset += writePrefix(buffer, offset, array.length, tokens.array, 0xdc)
  if (offset > MAX_SIZE) {
    overflow = true
  }
  return offset
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
