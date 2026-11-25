'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../setup/core')
const { decodeVarint, encodeVarintInto } = require('../../src/datastreams/encoding')

/** @param {number} value */
function encode (value) {
  const bytes = new Uint8Array(9)
  return bytes.subarray(0, encodeVarintInto(bytes, 0, value))
}

describe('encoding', () => {
  describe('encodeVarInt', () => {
    it('encoding then decoding should be a no op for int32 numbers', () => {
      const n = 1679672748
      const expectedEncoded = new Uint8Array([216, 150, 238, 193, 12])
      const encoded = encode(n)
      assert.deepStrictEqual(encoded, expectedEncoded)
      assert.deepStrictEqual(decodeVarint(encoded, 0), [n, encoded.length])
    })

    it('encoding then decoding should be a no op for bigger than int32 numbers', () => {
      const n = 1679711644352
      const expectedEncoded = new Uint8Array([
        128, 171, 237, 233, 226, 97,
      ])
      const bytes = new Uint8Array(2 * expectedEncoded.length)
      const edgeOffset = encodeVarintInto(bytes, 0, n)
      const end = encodeVarintInto(bytes, edgeOffset, n)
      assert.deepStrictEqual(bytes, Uint8Array.from([...expectedEncoded, ...expectedEncoded]))
      assert.deepStrictEqual(decodeVarint(bytes, 0), [n, edgeOffset])
      assert.deepStrictEqual(decodeVarint(bytes, edgeOffset), [n, end])
    })

    it('encoding then decoding should be a no op at the largest encodable magnitude', () => {
      const n = Math.floor(Number.MAX_SAFE_INTEGER / 2)

      const encoded = encode(n)
      assert.deepStrictEqual([...encoded], [254, 255, 255, 255, 255, 255, 255, 15])
      assert.deepStrictEqual(decodeVarint(encoded, 0), [n, encoded.length])

      const encodedNegative = encode(-n)
      assert.deepStrictEqual([...encodedNegative], [255, 255, 255, 255, 255, 255, 255, 15])
      assert.deepStrictEqual(decodeVarint(encodedNegative, 0), [-n, encodedNegative.length])
    })

    it('encoding then decoding should be a no op when a group shifts down to 0x80', () => {
      // The zig-zag value shifts down to exactly 0x80 for `2 ** exponent` and the
      // `2 ** (exponent - 7)` values above it. Math.floor(Number.MAX_SAFE_INTEGER / 2)
      // spans seven 7-bit groups, so there are seven such bands.
      for (let exponent = 6; exponent <= 48; exponent += 7) {
        const base = 2 ** exponent
        const bandTop = base + 2 ** Math.max(exponent - 7, 0) - 1

        for (const n of new Set([base, bandTop, -base, -bandTop])) {
          const encoded = encode(n)
          assert.deepStrictEqual(decodeVarint(encoded, 0), [n, encoded.length])
        }
      }

      assert.deepStrictEqual([...encode(2 ** 6)], [128, 1])
    })

    it('leaves the offset and bytes unchanged above the maximum magnitude', () => {
      const bytes = Uint8Array.of(1, 2)
      assert.strictEqual(encodeVarintInto(bytes, 1, Math.ceil(Number.MAX_SAFE_INTEGER / 2)), 1)
      assert.deepStrictEqual(bytes, Uint8Array.of(1, 2))
    })
  })

  it('preserves decoding at the ninth byte even if it has a continuation bit', () => {
    const bytes = Uint8Array.of(0, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0xff)
    assert.deepStrictEqual(decodeVarint(bytes, 1), [-(2 ** 62), 10])
  })
})
