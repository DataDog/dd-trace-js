'use strict'

const { randomFillSync } = require('crypto')

const UINT_MAX = 4294967296

const data = new Uint8Array(8 * 8192)
const zeroIdBuffer = new Uint8Array(8)
const zeroId = {
  toArray: () => zeroIdBuffer,
  toString: () => '0',
  toJSON: () => '0'
}

let batch = 0

function id (value, raddix) {
  const buffer = value
    ? fromNumberString(value, raddix)
    : pseudoRandom()

  return {
    toArray: () => buffer,
    toString: (raddix) => toNumberString(buffer, raddix),
    toJSON: () => toNumberString(buffer)
  }
}

function pseudoRandom () {
  if (batch === 0) {
    randomFillSync(data)
  }

  batch = (batch + 1) % 8192

  const offset = batch * 8

  return [
    data[offset] & 0x7F, // only positive int64
    data[offset + 1],
    data[offset + 2],
    data[offset + 3],
    data[offset + 4],
    data[offset + 5],
    data[offset + 6],
    data[offset + 7]
  ]
}

function fromNumberString (str, raddix = 10) {
  const buffer = new Array(8)
  const len = str.length

  let pos = 0
  let high = 0
  let low = 0

  if (str[0] === '-') pos++

  const sign = pos

  while (pos < len) {
    const chr = parseInt(str[pos++], raddix)

    if (!(chr >= 0)) break // NaN

    low = low * raddix + chr
    high = high * raddix + Math.floor(low / UINT_MAX)
    low %= UINT_MAX
  }

  if (sign) {
    high = ~high

    if (low) {
      low = UINT_MAX - low
    } else {
      high++
    }
  }

  writeUInt32BE(buffer, high, 0)
  writeUInt32BE(buffer, low, 4)

  return buffer
}

function toNumberString (buffer, radix = 10) {
  let high = readInt32(buffer, 0)
  let low = readInt32(buffer, 4)
  let str = ''

  while (1) {
    const mod = (high % radix) * UINT_MAX + low

    high = Math.floor(high / radix)
    low = Math.floor(mod / radix)
    str = (mod % radix).toString(radix) + str

    if (!high && !low) break
  }

  return str
}

function readInt32 (buffer, offset) {
  return (buffer[offset + 0] * 16777216) +
    (buffer[offset + 1] << 16) +
    (buffer[offset + 2] << 8) +
    buffer[offset + 3]
}

function writeUInt32BE (buffer, value, offset) {
  buffer[3 + offset] = value & 255
  value = value >> 8
  buffer[2 + offset] = value & 255
  value = value >> 8
  buffer[1 + offset] = value & 255
  value = value >> 8
  buffer[0 + offset] = value & 255
}

module.exports = { id, zeroId }
