'use strict'

const { randomFillSync } = require('crypto')

const zeroId = Buffer.alloc(8)
const data = Buffer.allocUnsafe(8 * 8192)
let batch = 0

class Identifier {
  #buffer

  /**
   * Creates a new Identifier instance.
   *
   * If `value` is not provided, a random ID will be generated.
   *
   * @param {string} [value] - The value to create the ID from. It must represent a 64 or 128 bit ID.
   * @param {number} [radix=16] - The radix to use for the conversion.
   */
  constructor (value, radix = 16) {
    if (!value) {
      this.#buffer = pseudoRandom()
    } else if (radix === 16) {
      // TODO: What should we do if the value is too long?
      this.#buffer = value === '0' ? zeroId : Buffer.from(value.padStart(value.length > 16 ? 32 : 16, '0'), 'hex')
    } else {
      const buffer = Buffer.alloc(8)
      const bigint = BigInt(value)
      if (value.startsWith('-')) {
        buffer.writeBigInt64BE(bigint)
      } else {
        buffer.writeBigUInt64BE(bigint)
      }
      this.#buffer = buffer
    }
  }

  is128bit () {
    return this.#buffer.length !== 8
  }

  /**
   * Converts the last 8 bytes of the current ID to a string.
   * If the radix is 16, the string will be in hexadecimal format.
   * If the radix is not 16, the string will be in decimal format.
   *
   * @param {number} radix - The radix to use for the conversion.
   * @returns {string} - The string representation of the ID.
   */
  toString (radix = 16) {
    if (radix === 16) {
      return this.#buffer.toString('hex')
    }
    // TODO: Should we really only return the last 64 bits?
    return this.#buffer.readBigUInt64BE(this.#buffer.length - 8).toString(radix)
  }

  toFirst64BitsBigInt () {
    return this.#buffer.readBigUInt64BE(0)
  }

  /**
   * Writes the last 64 bits of the current ID to a buffer.
   *
   * @param {Buffer} buffer - The buffer to write the ID to.
   * @param {number} offset - The offset to write the ID to.
   * @returns {Buffer} - The buffer with the ID written to it.
   */
  writeToLast64Bits (buffer, offset) {
    buffer[offset] = 0xCF
    const copyOffset = this.#buffer.length - 8
    this.#buffer.copy(buffer, offset + 1, copyOffset, copyOffset + 8)
    return buffer
  }

  get length () {
    return this.#buffer.length
  }

  toJSON () {
    return this.toString()
  }

  /**
   * Checks if the current ID is equal to another ID.
   * If either ID is longer than the other ID, the longer ID will be truncated to the length of the shorter ID.
   * Only the last 64 bits of the longer ID will be compared in that case.
   *
   * @param {Identifier} other - The other ID to compare with.
   * @returns {boolean} - `true` if the IDs are equal, otherwise `false`.
   */
  equals (other) {
    let otherBuffer = other.#buffer
    let thisBuffer = this.#buffer
    if (other.#buffer.length > this.#buffer.length) {
      otherBuffer = other.#buffer.subarray(-this.#buffer.length)
    }
    if (other.#buffer.length < this.#buffer.length) {
      thisBuffer = this.#buffer.subarray(-other.#buffer.length)
    }
    return thisBuffer.equals(otherBuffer)
  }
}

function pseudoRandom () {
  if (batch === 0) randomFillSync(data)
  batch = (batch + 1) % 8192
  const offset = batch * 8
  const buffer = Buffer.alloc(8)
  data.copy(buffer, 0, offset, offset + 8)
  buffer[0] &= 0x7F // Only positive int64
  return buffer
}

module.exports = function createIdentifier (value, radix) {
  return new Identifier(value, radix)
}
