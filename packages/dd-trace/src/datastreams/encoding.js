const { toBufferLE } = require('bigint-buffer')

const maxVarLen64 = 9

function decodeVarUint64 (b) {
  let x = 0
  let s = 0
  for (let i = 0; i < maxVarLen64; i++) {
    if (b.length <= i) {
      throw new Error('EOFError')
    }
    const n = b[i]
    if (n < 0x80 || i === maxVarLen64 - 1) {
      return [x | n << s, b.slice(i + 1)]
    }
    x |= (n & 0x7F) << s
    s += 7
  }
  throw new Error('EOFError')
}

function decodeVarInt64 (b) {
  const result = decodeVarUint64(b)
  const v = result[0]
  b = result[1]
  return [(v >> 1) ^ -(v & 1), b]
}

function encodeVarInt64 (v) {
  return encodeVarUint64(v >> BigInt(64 - 1) ^ (v << BigInt(1)))
}

function encodeVarUint64 (v) {
  let b = Buffer.from('')
  for (let i = 0; i < maxVarLen64; i++) {
    if (v < 0x80n) {
      break
    }
    b = Buffer.concat([b, toBufferLE(v & 0xffn | 0x80n, 1)])
    v >>= 7n
  }
  b = Buffer.concat([b, toBufferLE(v & 0xffn, 1)])
  return b
}

module.exports = {
  decodeVarInt64,
  encodeVarInt64
}
