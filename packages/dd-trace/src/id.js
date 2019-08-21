'use strict'

const Uint64BE = require('./uint64be') // TODO: remove dependency
const platform = require('./platform')

// Cryptographically secure local seeds to mitigate Math.random() seed reuse.
const seed = new Uint32Array(2)

platform.crypto.getRandomValues(seed)

// Internal representation of a trace or span ID.
class Identifier {
  constructor (value, radix) {
    this._buffer = typeof radix === 'number'
      ? new Uint8Array(new Uint64BE(value, radix).toArrayBuffer())
      : createBuffer(value)
  }

  toString (radix) {
    if (typeof radix === 'number') {
      return this.toUint64BE().toString()
    } else {
      return Array.from(this._buffer)
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('')
    }
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
  if (!value) return pseudoRandom()

  const size = Math.ceil(value.length / 2)
  const buffer = new Uint8Array(size)

  for (let i = 0; i < size; i++) {
    buffer[i] = parseInt(value.substr(i * 2, 2), 16)
  }

  return buffer
}

// Simple pseudo-random 64-bit ID generator.
function pseudoRandom () {
  const buffer = new Uint8Array(8)

  const hi = randomUInt32(seed[0]) & 0x7FFFFFFF // only positive int64
  const lo = randomUInt32(seed[1])

  writeUInt32BE(buffer, hi, 0)
  writeUInt32BE(buffer, lo, 4)

  return buffer
}

// Generate a random unsigned 32-bit integer.
function randomUInt32 (seed) {
  return seed ^ Math.floor(Math.random() * (0xFFFFFFFF + 1))
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
