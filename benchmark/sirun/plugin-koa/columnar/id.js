'use strict'

const { randomFillSync } = require('crypto')

const UINT_MAX = 4294967296

const data = new BigUint64Array(8192)
const zeroId = 0n

let batch = 0

function id (value, raddix) {
  const buffer = value
    ? fromNumberString(value, raddix)
    : pseudoRandom()

  return buffer
}

function pseudoRandom () {
  if (batch === 0) {
    randomFillSync(data)
  }

  batch = (batch + 1) % 8192

  return data[batch]
}

function fromNumberString (str, raddix = 10) {
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

  if (high === 0 && low === 0) return zeroId

  const buffer = new Array(8) // TODO: use existing buffer

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

module.exports = { id, zeroId, toNumberString }
