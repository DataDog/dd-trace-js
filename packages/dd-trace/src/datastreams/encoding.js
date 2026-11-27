'use strict'

const maxVarLen64 = 9

/**
 * Writes a zig-zag varint and returns the offset just past the last byte written.
 * Returns the original offset when the magnitude exceeds MAX_SAFE_INTEGER/2.
 * @param {Uint8Array | Buffer} target
 * @param {number} offset
 * @param {number} value
 */
function encodeVarintInto (target, offset, value) {
  const sign = value >= 0 ? 0 : 1
  // We leave the least significant bit for the sign.
  const double = Math.abs(value) * 2
  if (double > Number.MAX_SAFE_INTEGER) {
    return offset
  }
  let high = Math.floor(double / 0x1_00_00_00_00)
  let low = (double & 0xFF_FF_FF_FF) | sign
  let i = offset
  const limit = offset + maxVarLen64 - 1
  // if first byte is 1, the number is negative in javascript, but we want to interpret it as positive
  while ((high !== 0 || low < 0 || low > 0x7F) && i < limit) {
    target[i] = (low & 0x7F) | 0x80
    low >>>= 7
    low |= (high & 0x7F) << 25
    high >>>= 7
    i++
  }
  target[i] = low & 0x7F
  return i + 1
}

/**
 * Reads a zig-zag varint and returns its value and the offset of the next byte.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {[number | undefined, number]}
 */
function decodeVarint (bytes, offset) {
  let low = 0
  let high = 0
  const lastShift = (maxVarLen64 - 1) * 7
  for (let shift = 0; offset < bytes.length; shift += 7) {
    const byte = bytes[offset++]
    const done = byte < 0x80 || shift === lastShift
    const value = done ? byte : byte & 0x7F
    if (shift < 32) {
      low |= value << shift
    }
    if (shift > 0) {
      high |= shift > 32 ? value << (shift - 32) : value >> (32 - shift)
    }
    if (done) {
      const magnitude = (low >>> 1) + high * 0x80_00_00_00
      return [(low & 1) === 0 ? magnitude : -magnitude, offset]
    }
  }
  return [undefined, offset]
}

module.exports = {
  encodeVarintInto,
  decodeVarint,
}
