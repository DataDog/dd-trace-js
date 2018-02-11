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

const cache = {}

function encode (trace) {
  const buffers = []

  buffers.push(prefixArray(trace))

  trace.forEach(span => {
    buffers.push(prefixObject(span))

    writeString(buffers, 'trace_id')
    writeId(buffers, span.trace_id)

    writeString(buffers, 'span_id')
    writeId(buffers, span.span_id)

    writeString(buffers, 'parent_id')
    if (span.parent_id) {
      writeId(buffers, span.parent_id)
    } else {
      buffers.push(types.null)
    }

    writeString(buffers, 'name')
    writeString(buffers, span.name)

    writeString(buffers, 'resource')
    writeString(buffers, span.resource)

    writeString(buffers, 'service')
    writeString(buffers, span.service)

    writeString(buffers, 'type')
    writeString(buffers, span.type)

    writeString(buffers, 'error')
    buffers.push(prefixes.int[span.error])

    writeString(buffers, 'meta')
    writeMap(buffers, span.meta)

    writeString(buffers, 'start')
    writeInt(buffers, span.start)

    writeString(buffers, 'duration')
    writeInt(buffers, span.duration)
  })

  return buffers
}

function string (value) {
  if (typeof value === 'string' && !cache[value]) {
    cache[value] = Buffer.from(value, 'utf-8')
  }

  return cache[value]
}

function writeId (buffers, value) {
  buffers.push(types.uint64)
  buffers.push(value.buffer)
}

function writeInt (buffers, value) {
  let buffer

  if (value <= 0xff) { // int 8
    buffer = Buffer.allocUnsafe(2)
    writeUInt8(buffer, 0xcc, 0)
    writeUInt8(buffer, value, 1)
  } else if (value <= 0xffff) { // int 16
    buffer = Buffer.allocUnsafe(3)
    writeUInt8(buffer, 0xcd, 0)
    writeUInt16(buffer, value, 1)
  } else if (value <= 0xffffffff) { // int 32
    buffer = Buffer.allocUnsafe(5)
    writeUInt8(buffer, 0xce, 0)
    writeUInt32(buffer, value, 1)
  } else { // int 64
    const hi = Math.floor(value / 4294967296)
    const lo = value % 4294967296

    buffer = Buffer.allocUnsafe(9)
    writeUInt8(buffer, 0xcf, 0)
    writeUInt32(buffer, hi, 1)
    writeUInt32(buffer, lo, 5)
  }

  buffers.push(buffer)
}

function writeString (buffers, value) {
  const buffer = string(value)
  buffers.push(prefixString(buffer))
  buffers.push(buffer)
}

function writeMap (buffers, map) {
  buffers.push(prefixObject(map))

  for (const key in map) {
    buffers.push(prefixString(key))
    buffers.push(string(key))

    buffers.push(prefixString(map[key]))
    buffers.push(map[key])
  }
}

function writeUInt8 (buffer, value, offset) {
  buffer[offset] = value
}
function writeUInt16 (buffer, value, offset) {
  buffer[offset] = value >> 8
  buffer[offset + 1] = value & 0xff
}

function writeUInt32 (buffer, value, offset) {
  buffer[offset] = value >> 24
  buffer[offset + 1] = value >> 16 & 0xff
  buffer[offset + 2] = value >> 8 & 0xff
  buffer[offset + 3] = value & 0xff
}

function prefixString (string) {
  return prefix(string ? Buffer.byteLength(string) : 0, prefixes.str, 0xda)
}

function prefixArray (array) {
  return prefix(array.length, prefixes.array, 0xdc)
}

function prefixObject (obj) {
  let length = 0

  for (const key in obj) { // eslint-disable-line no-unused-vars
    length++
  }

  return prefix(length, prefixes.map, 0xde)
}

function prefix (length, prefixCache, startByte) {
  let buffer

  if (length <= 0xff) {
    buffer = prefixCache[length]
  } else if (length <= 0xffff) {
    buffer = Buffer.allocUnsafe(3)
    writeUInt8(buffer, startByte, 0)
    writeUInt16(buffer, length, 1)
  } else {
    buffer = Buffer.allocUnsafe(5)
    writeUInt8(buffer, startByte + 1, 0)
    writeUInt32(buffer, length, 1)
  }

  return buffer
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

module.exports = encode
