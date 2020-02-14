'use strict'

const util = require('./util')

function getStrPrefixes () {
  const values = []

  for (let i = 0; i < 32; i++) {
    values[i] = Buffer.allocUnsafe(1)
    util.writeUInt8(values[i], 0xa0 + i, 0)
  }

  for (let i = 32; i <= 0xff; i++) {
    values[i] = Buffer.allocUnsafe(2)
    util.writeUInt8(values[i], 0xd9, 0)
    util.writeUInt8(values[i], i, 1)
  }

  for (let i = 256; i <= 0xffff; i++) {
    values[i] = Buffer.allocUnsafe(3)
    util.writeUInt8(values[i], 0xda, 0)
    util.writeUInt16(values[i], i, 1)
  }

  return values
}

function getIntPrefixes () {
  const values = []

  for (let i = 0; i < 128; i++) {
    values[i] = Buffer.allocUnsafe(1)
    util.writeUInt8(values[i], i, 0)
  }

  return values
}

function getArrayPrefixes () {
  const values = []

  for (let i = 0; i <= 0xf; i++) {
    values[i] = Buffer.allocUnsafe(1)
    util.writeUInt8(values[i], 0x90 + i, 0)
  }

  for (let i = 0x10; i <= 0xffff; i++) {
    values[i] = Buffer.allocUnsafe(3)
    util.writeUInt8(values[i], 0xdc, 0)
    util.writeUInt16(values[i], i, 1)
  }

  return values
}

function getMapPrefixes () {
  const values = []

  for (let i = 0; i <= 0xf; i++) {
    values[i] = Buffer.allocUnsafe(1)
    util.writeUInt8(values[i], 0x80 + i, 0)
  }

  for (let i = 16; i <= 0xffff; i++) {
    values[i] = Buffer.allocUnsafe(3)
    util.writeUInt8(values[i], 0xde, 0)
    util.writeUInt16(values[i], i, 1)
  }

  return values
}

module.exports = {
  str: getStrPrefixes(),
  int: getIntPrefixes(),
  array: getArrayPrefixes(),
  map: getMapPrefixes(),
  null: Buffer.alloc(1, 0xc0),
  uint8: Buffer.alloc(1, 0xcc),
  uint32: Buffer.alloc(1, 0xce),
  uint64: Buffer.alloc(1, 0xcf),
  int64: Buffer.alloc(1, 0xd3)
}
