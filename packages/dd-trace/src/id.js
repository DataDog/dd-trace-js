'use strict'

const { randomFillSync } = require('crypto')

const UINT_MAX = 4_294_967_296

const data = new Uint8Array(8 * 8192)
const zeroId = new Uint8Array(8)

const map = Array.prototype.map
const pad = byte => `${byte < 16 ? '0' : ''}${byte.toString(16)}`

let batch = 0

// When DD_TRACE_SECURE_RANDOM=true, bypass the batch buffer entirely and call
// randomFillSync on a fresh 8-byte buffer per ID. The batch buffer is heap state
// that may be duplicated across process copies; per-call kernel reads have no
// buffered state and guarantee ID uniqueness regardless of process origin.
// id.js is a foundational module loaded before config initializes, so we read
// the env var directly rather than going through the config system.
// eslint-disable-next-line eslint-rules/eslint-process-env
const _secureRandom = process.env.DD_TRACE_SECURE_RANDOM === 'true'
const _secureBuf = _secureRandom ? new Uint8Array(8) : null

// Internal representation of a trace or span ID.
class Identifier {
  /**
   * @param {string} value
   * @param {number} [radix]
   */
  constructor (value, radix = 16) {
    this._buffer = radix === 16
      ? createBuffer(value)
      : fromString(value, radix)
  }

  /**
   * @param {number} [radix]
   * @returns {string}
   */
  toString (radix = 16) {
    return radix === 16
      ? toHexString(this._buffer)
      : toNumberString(this._buffer, radix)
  }

  /**
   * @returns {bigint}
   */
  toBigInt () {
    return Buffer.from(this._buffer).readBigUInt64BE(0)
  }

  /**
   * @returns {number[] | Uint8Array}
   */
  toBuffer () {
    return this._buffer
  }

  /**
   * @returns {number[] | Uint8Array}
   */
  toArray () {
    if (this._buffer.length === 8) {
      return this._buffer
    }
    return this._buffer.slice(-8)
  }

  /**
   * @returns {string}
   */
  toJSON () {
    return this.toString()
  }

  /**
   * @param {Identifier} other
   * @returns {boolean}
   */
  equals (other) {
    const length = this._buffer.length
    const otherLength = other._buffer.length

    // Only compare the bytes available in both IDs.
    for (let i = length, j = otherLength; i >= 0 && j >= 0; i--, j--) {
      if (this._buffer[i] !== other._buffer[j]) return false
    }

    return true
  }
}

// Create a buffer, using an optional hexadecimal value if provided.
/**
 * @param {string} value
 * @returns {number[] | Uint8Array}
 */
function createBuffer (value) {
  if (value === '0') return zeroId
  if (!value) return pseudoRandom()

  const size = Math.ceil(value.length / 16) * 16
  const bytes = size / 2
  const buffer = []

  value = value.padStart(size, '0')

  for (let i = 0; i < bytes; i++) {
    buffer[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  }

  return buffer
}

// Convert a numerical string to a buffer using the specified radix.
/**
 * @param {string} str
 * @param {number} raddix
 * @returns {number[]}
 */
function fromString (str, raddix) {
  const buffer = new Array(8)
  const len = str.length

  let pos = 0
  let high = 0
  let low = 0

  if (str[0] === '-') pos++

  const sign = pos

  while (pos < len) {
    const chr = Number.parseInt(str[pos++], raddix)

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
/**
 * @param {number[] | Uint8Array} buffer
 * @param {number} [radix]
 * @returns {string}
 */
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
/**
 * @param {number[] | Uint8Array} buffer
 * @returns {string}
 */
function toHexString (buffer) {
  return map.call(buffer, pad).join('')
}

// Simple pseudo-random 64-bit ID generator.
/**
 * @returns {number[] | Uint8Array}
 */
function pseudoRandom () {
  if (_secureBuf) {
    randomFillSync(_secureBuf)
    return [
      _secureBuf[0] & 0x7F,
      _secureBuf[1], _secureBuf[2], _secureBuf[3],
      _secureBuf[4], _secureBuf[5], _secureBuf[6], _secureBuf[7],
    ]
  }
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
    data[offset + 7],
  ]
}

// Read a buffer to unsigned integer bytes.
/**
 * @param {number[] | Uint8Array} buffer
 * @param {number} offset
 * @returns {number}
 */
function readInt32 (buffer, offset) {
  return (buffer[offset + 0] * 16_777_216) +
    (buffer[offset + 1] << 16) +
    (buffer[offset + 2] << 8) +
    buffer[offset + 3]
}

// Write unsigned integer bytes to a buffer.
/**
 * @param {number[] | Uint8Array} buffer
 * @param {number} value
 * @param {number} offset
 */
function writeUInt32BE (buffer, value, offset) {
  buffer[3 + offset] = value & 255
  value >>= 8
  buffer[2 + offset] = value & 255
  value >>= 8
  buffer[1 + offset] = value & 255
  value >>= 8
  buffer[0 + offset] = value & 255
}

/**
 * @param {string} [value]
 * @param {number} [radix]
 * @returns {Identifier}
 */
module.exports = function createIdentifier (value, radix) {
  return new Identifier(value ?? '', radix)
}

module.exports.Identifier = Identifier
