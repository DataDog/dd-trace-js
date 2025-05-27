'use strict'

// encodes positive and negative numbers, using zig zag encoding to reduce the size of the variable length encoding.
// uses high and low part to ensure those parts are under the limit for byte operations in javascript (32 bits)
// maximum number possible to encode is MAX_SAFE_INTEGER/2 (using zig zag shifts the bits by 1 to the left)
function encodeVarint (v) {
  const sign = v >= 0 ? 0 : 1
  // we leave the least significant bit for the sign.
  const double = Math.abs(v) * 2
  if (double > Number.MAX_SAFE_INTEGER) {
    return
  }
  const high = Math.floor(double / 0x1_00_00_00_00)
  const low = (double & 0xFF_FF_FF_FF) | sign
  return encodeUvarint64(low, high)
}

// decodes positive and negative numbers, using zig zag encoding to reduce the size of the variable length encoding.
// uses high and low part to ensure those parts are under the limit for byte operations in javascript (32 bits)
function decodeVarint (b) {
  const [low, high, bytes] = decodeUvarint64(b)
  if (low === undefined || high === undefined) {
    return [undefined, bytes]
  }
  const positive = (low & 1) === 0
  const abs = (low >>> 1) + high * 0x80_00_00_00
  return [positive ? abs : -abs, bytes]
}

const maxVarLen64 = 9

function encodeUvarint64 (low, high) {
  const result = new Uint8Array(maxVarLen64)
  let i = 0
  // if first byte is 1, the number is negative in javascript, but we want to interpret it as positive
  while ((high !== 0 || low < 0 || low > 0x80) && i < maxVarLen64 - 1) {
    result[i] = (low & 0x7F) | 0x80
    low >>>= 7
    low |= (high & 0x7F) << 25
    high >>>= 7
    i++
  }
  result[i] = low & 0x7F
  return result.slice(0, i + 1)
}

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
  decodeVarint
}
