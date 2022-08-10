'use strict'

const { randomFillSync } = require('crypto')

const UINT_MAX = 4294967296

const data = new Uint8Array(8 * 8192)
const zeroId = new Uint8Array(8)

const map = Array.prototype.map
const pad = byte => `${byte < 16 ? '0' : ''}${byte.toString(16)}`

let batch = 0

// Internal representation of a trace or span ID.
class Identifier {
  constructor (value, radix = 16) {
    this._isUint64BE = true // msgpack-lite compatibility
    this._buffer = radix === 16
      ? createBuffer(value)
      : fromString(value, radix)
  }

  toString (radix = 16) {
    return radix === 16
      ? toHexString(this._buffer)
      : toNumberString(this._buffer, radix)
  }

  toBuffer () {
    return this._buffer
  }

  // msgpack-lite compatibility
  toArray () {
    if (this._buffer.length === 8) {
      return this._buffer
    }
    return this._buffer.slice(-8)
  }

  toJSON () {
    return this.toString()
  }
}

// Create a buffer, using an optional hexadecimal value if provided.
function createBuffer (value) {
  if (value === '0') return zeroId
  if (!value) return pseudoRandom()

  const size = Math.ceil(value.length / 16) * 16
  const bytes = size / 2
  const buffer = new Array(bytes)

  value = value.padStart(size, '0')

  for (let i = 0; i < bytes; i++) {
    buffer[i] = parseInt(value.substring(i * 2, i * 2 + 2), 16)
  }

  return buffer
}

// Convert a numerical string to a buffer using the specified radix.
function fromString (str, raddix) {
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

// Convert a buffer to a numerical string.
function toNumberString (buffer, radix) {
  let high = readInt32(buffer, buffer.length - 8)
  let low = readInt32(buffer, buffer.length - 4)
  let str = ''

  radix = radix || 10

  while (1) {
    const mod = (high % radix) * UINT_MAX + low

    high = Math.floor(high / radix)
    low = Math.floor(mod / radix)
    str = (mod % radix).toString(radix) + str

    if (!high && !low) break
  }

  return str
}

// Convert a buffer to a hexadecimal string.
function toHexString (buffer) {
  return map.call(buffer, pad).join('')
}

// Simple pseudo-random 64-bit ID generator.
function pseudoRandom () {
  if (batch === 0) {
    randomFillSync(data)
  }

  batch = (batch + 1) % 8192

  const offset = batch * 8

  return [
    data[offset] & 0x7F, // only positive int64,
    data[offset + 1],
    data[offset + 2],
    data[offset + 3],
    data[offset + 4],
    data[offset + 5],
    data[offset + 6],
    data[offset + 7]
  ]
}

// Read a buffer to unsigned integer bytes.
function readInt32 (buffer, offset) {
  return (buffer[offset + 0] * 16777216) +
    (buffer[offset + 1] << 16) +
    (buffer[offset + 2] << 8) +
    buffer[offset + 3]
}

// Write unsigned integer bytes to a buffer.
function writeUInt32BE (buffer, value, offset) {
  buffer[3 + offset] = value & 255
  value = value >> 8
  buffer[2 + offset] = value & 255
  value = value >> 8
  buffer[1 + offset] = value & 255
  value = value >> 8
  buffer[0 + offset] = value & 255
}

module.exports = (value, radix) => new Identifier(value, radix)
