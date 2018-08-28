'use strict'

const Buffer = require('safe-buffer').Buffer

const prefixes = {
  str: getStrPrefixes(),
  int: getIntPrefixes(),
  array: getArrayPrefixes(),
  map: getMapPrefixes()
}

const types = {
  null: Buffer.alloc(1, 0xc0),
  uint8: Buffer.alloc(1, 0xcc),
  uint32: Buffer.alloc(1, 0xce),
  uint64: Buffer.alloc(1, 0xcf)
}

const reserved = {
  traceId: Buffer.from('trace_id'),
  spanId: Buffer.from('span_id'),
  parentId: Buffer.from('parent_id'),
  service: Buffer.from('service'),
  resource: Buffer.from('resource'),
  name: Buffer.from('name'),
  type: Buffer.from('type'),
  error: Buffer.from('error'),
  meta: Buffer.from('meta'),
  start: Buffer.from('start'),
  duration: Buffer.from('duration')
}

const cache = {}

function encode (buffer, offset, trace) {
  // offset = writeArrayPrefix(buffer, offset, trace)

  trace.forEach(span => {
    // offset = writeObjectPrefix(buffer, offset, span)

    offset = reserved.traceId.copy(buffer, offset)
    // offset = writeId(buffer, offset, span.trace_id)

    offset = reserved.spanId.copy(buffer, offset)
    // offset = writeId(buffer, offset, span.span_id)

    offset = reserved.parentId.copy(buffer, offset)

    if (span.parent_id) {
      // offset = writeId(buffer, offset, span.parent_id)
    } else {
      offset += types.null.copy(buffer, offset)
    }

    offset = reserved.name.copy(buffer, offset)
    offset = string(span.name).copy(buffer, offset)

    offset = reserved.resource.copy(buffer, offset)
    string(span.resource).copy(buffer, offset)

    offset = reserved.service.copy(buffer, offset)
    // offset = writeString(buffer, offset, span.service)

    if (span.type !== undefined) {
      offset = reserved.type.copy(buffer, offset)
      // offset = writeString(buffer, offset, span.type)
    }

    offset = reserved.error.copy(buffer, offset)
    offset = prefixes.int[span.error].copy(buffer, offset)

    offset = reserved.meta.copy(buffer, offset)
    offset = writeMap(buffer, offset, span.meta)

    offset = reserved.start.copy(buffer, offset)
    // offset = writeInt(buffer, offset, span.start)

    offset = reserved.duration.copy(buffer, offset)
    // offset = writeInt(buffer, offset, span.duration)
  })

  return offset
}

function string (value) {
  if (typeof value === 'string' && !cache[value]) {
    cache[value] = Buffer.from(value, 'utf-8')
  }

  return cache[value]
}

function getStrPrefixes () {
  const values = []

  for (let i = 0; i < 32; i++) {
    values[i] = Buffer.allocUnsafe(1)
    writeUInt8(values[i], 0xa0 + i, 0)
  }

  for (let i = 32; i < 256; i++) {
    values[i] = Buffer.allocUnsafe(2)
    writeUInt8(values[i], 0xd9, 0)
    writeUInt8(values[i], i, 1)
  }

  return values
}

function getIntPrefixes () {
  const values = []

  for (let i = 0; i < 128; i++) {
    values[i] = Buffer.allocUnsafe(1)
    writeUInt8(values[i], i, 0)
  }

  return values
}

function getArrayPrefixes () {
  const values = []

  for (let i = 0; i < 16; i++) {
    values[i] = Buffer.allocUnsafe(1)
    writeUInt8(values[i], 0x90 + i, 0)
  }

  for (let i = 16; i < 256; i++) {
    values[i] = Buffer.allocUnsafe(3)
    writeUInt8(values[i], 0xdc, 0)
    writeUInt8(values[i], 0x00, 1)
    writeUInt8(values[i], i, 2)
  }

  return values
}

function getMapPrefixes () {
  const values = []

  for (let i = 0; i < 16; i++) {
    values[i] = Buffer.allocUnsafe(1)
    writeUInt8(values[i], 0x80 + i, 0)
  }

  for (let i = 16; i < 256; i++) {
    values[i] = Buffer.allocUnsafe(3)
    writeUInt8(values[i], 0xde, 0)
    writeUInt8(values[i], 0x00, 1)
    writeUInt8(values[i], i, 2)
  }

  return values
}

// ============================================================================

function writeString (buffer, offset, value) {
  offset = writeStringPrefix(buffer, offset, value)
  offset += buffer.write(value, offset, 'utf-8')

  return offset
}

function writeId (buffer, offset, value) {
  offset = writeUInt8(buffer, types.uint64, offset)
  offset += value.toBuffer().copy(buffer, offset)

  return offset
}

function writeInt (buffer, offset, value) {
  // if (value <= 0xff) { // int 8
  //   // offset = writeUInt8(buffer, 0xcc, offset)
  //   // offset = writeUInt8(buffer, value, offset)
  // } else if (value <= 0xffff) { // int 16
  //   // offset = writeUInt8(buffer, 0xcd, offset)
  //   // offset = writeUInt16(buffer, value, offset)
  // } else if (value <= 0xffffffff) { // int 32
  //   // offset = writeUInt8(buffer, 0xce, offset)
  //   // offset = writeUInt32(buffer, value, offset)
  // } else { // int 64
  //   // const hi = Math.floor(value / 4294967296)
  //   // const lo = value % 4294967296

  //   // offset = writeUInt8(buffer, 0xcf, offset)
  //   // offset = writeUInt32(buffer, hi, offset)
  //   // offset = writeUInt32(buffer, lo, offset)
  // }

  return offset
}

function writeUInt8 (buffer, value, offset) {
  buffer[offset] = value

  return offset + 1
}
function writeUInt16 (buffer, value, offset) {
  buffer[offset] = value >> 8
  buffer[offset + 1] = value & 0xff

  return offset + 2
}

function writeUInt32 (buffer, value, offset) {
  buffer[offset] = value >> 24
  buffer[offset + 1] = value >> 16 & 0xff
  buffer[offset + 2] = value >> 8 & 0xff
  buffer[offset + 3] = value & 0xff

  return offset + 4
}

function writeMap (buffer, offset, map) {
  // offset = writeObjectPrefix(buffer, offset, map)

  // for (const key in map) {
  //   offset = writeStringPrefix(buffer, offset, map)
  //   offset = writeString(buffer, offset, key)

  //   offset = writeStringPrefix(buffer, offset, map[key])
  //   offset = writeString(buffer, offset, map[key])
  // }

  return offset
}

function writePrefix (buffer, offset, length, prefixCache, startByte) {
  if (length <= 0xff) {
    offset = writeUInt8(buffer, prefixCache[length], offset)
  } else if (length <= 0xffff) {
    offset = writeUInt8(buffer, startByte, offset)
    offset = writeUInt16(buffer, length, offset)
  } else {
    offset = writeUInt8(buffer, startByte + 1, offset)
    offset = writeUInt32(buffer, length, offset)
  }

  return offset
}

function writeStringPrefix (buffer, offset, string) {
  return writePrefix(buffer, offset, string ? Buffer.byteLength(string) : 0, prefixes.str, 0xda)
}

function writeArrayPrefix (buffer, offset, array) {
  return writePrefix(buffer, offset, array.length, prefixes.array, 0xdc)
}

function writeObjectPrefix (buffer, offset, obj) {
  let length = 0

  for (const key in obj) { // eslint-disable-line no-unused-vars
    length++
  }

  return writePrefix(buffer, offset, length, prefixes.map, 0xde)
}

module.exports = encode
