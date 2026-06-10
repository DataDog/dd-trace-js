'use strict'

const maxVarLen64 = 9

/**
 * Encodes positive and negative numbers, using zig zag encoding to reduce the size of the variable length encoding.
 * Uses high and low part to ensure those parts are under the limit for byte operations in javascript (32 bits)
 * Maximum number possible to encode is MAX_SAFE_INTEGER/2 (using zig zag shifts the bits by 1 to the left)
 * @param {number} v
 * @returns {Uint8Array|undefined}
 */
function encodeVarint (v) {
  const result = new Uint8Array(maxVarLen64)
  const written = encodeVarintInto(result, 0, v)
  if (written === 0) {
    return
  }
  return result.slice(0, written)
}

/**
 * Writes a zig-zag varint at `target[offset..]` and returns the offset just past the last
 * byte written. Returns `offset` unchanged when the value exceeds MAX_SAFE_INTEGER/2, mirroring
 * the `encodeVarint` overflow contract. Used on the DSM checkpoint hot path to avoid
 * per-call Uint8Array / Buffer allocations.
 * @param {Uint8Array | Buffer} target
 * @param {number} offset
 * @param {number} value
 * @returns {number}
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
  while ((high !== 0 || low < 0 || low > 0x80) && i < limit) {
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
 * Decodes positive and negative numbers, using zig zag encoding to reduce the size of the variable length encoding.
 * Uses high and low part to ensure those parts are under the limit for byte operations in javascript (32 bits)
 * @param {Uint8Array} b
 * @returns {[number|undefined, Uint8Array]}
 */
function decodeVarint (b) {
  const [low, high, bytes] = decodeUvarint64(b)
  if (low === undefined || high === undefined) {
    return [undefined, bytes]
  }
  const positive = (low & 1) === 0
  const abs = (low >>> 1) + high * 0x80_00_00_00
  return [positive ? abs : -abs, bytes]
}

/**
 * @param {Uint8Array} bytes
 * @returns {[number|undefined, number|undefined, Uint8Array]}
 */
function decodeUvarint64 (
  bytes
) {
  let low = 0
  let high = 0
  let s = 0
  for (let i = 0; ; i++) {
    if (bytes.length <= i) {
      return [undefined, undefined, bytes.slice(bytes.length)]
    }
    const n = bytes[i]
    if (n < 0x80 || i === maxVarLen64 - 1) {
      bytes = bytes.slice(i + 1)
      if (s < 32) {
        low |= n << s
      }
      if (s > 0) {
        high |= s - 32 > 0 ? n << (s - 32) : n >> (32 - s)
      }
      return [low, high, bytes]
    }
    if (s < 32) {
      low |= (n & 0x7F) << s
    }
    if (s > 0) {
      high |=
        s - 32 > 0 ? (n & 0x7F) << (s - 32) : (n & 0x7F) >> (32 - s)
    }
    s += 7
  }
}

module.exports = {
  encodeVarint,
  encodeVarintInto,
  decodeVarint,
}
