'use strict'

const Uint64BE = require('./uint64be')
const randomBytes = require('crypto').randomBytes

// Cryptographically secure local seeds to mitigate Math.random() seed reuse.
const hiSeed = randomBytes(4).readUInt32BE()
const loSeed = randomBytes(4).readUInt32BE()

// Internal representation of a trace or span ID.
class Identifier {
  constructor (value, radix) {
    this._buffer = typeof radix === 'number'
      ? new Uint64BE(value, radix).toBuffer()
      : createBuffer(value)
  }

  toString (radix) {
    return typeof radix === 'number'
      ? this.toUint64BE().toString()
      : this._buffer.toString('hex')
  }

  toUint64BE () {
    return new Uint64BE(this._buffer.slice(-8))
  }

  toJSON () {
    return this.toString()
  }
}

// Create a buffer, using an optional hexadecimal value if provided.
function createBuffer (value) {
  if (value) return Buffer.from(value, 'hex')

  return pseudoRandom()
}

// Simple pseudo-random 64-bit ID generator.
function pseudoRandom () {
  const buffer = Buffer.allocUnsafe(8)

  const hi = randomUInt32(hiSeed) & 0x7FFFFFFF // only positive int64
  const lo = randomUInt32(loSeed)

  writeUInt32BE(buffer, hi, 0)
  writeUInt32BE(buffer, lo, 4)

  return buffer
}

// Generate a random unsigned 32-bit integer.
function randomUInt32 (seed) {
  return seed ^ Math.floor(Math.random() * (0xFFFFFFFF + 1))
}

// Write unsigned integer bytes to a buffer. Faster than Buffer.writeUInt32BE().
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
