'use strict'

const { encodeVarint, decodeVarint } = require('../../src/datastreams/encoding')
const { expect } = require('chai')

describe('encoding', () => {
  describe('encodeVarInt', () => {
    it('encoding then decoding should be a no op for int32 numbers', () => {
      const n = 1679672748
      const expectedEncoded = new Uint8Array([216, 150, 238, 193, 12])
      const encoded = encodeVarint(n)
      expect(encoded.length).to.equal(expectedEncoded.length)
      expect(encoded.every((val, i) => val === expectedEncoded[i])).to.true
      const [decoded, bytes] = decodeVarint(encoded)
      expect(decoded).to.equal(n)
      expect(bytes).to.length(0)
    })
    it('encoding then decoding should be a no op for bigger than int32 numbers', () => {
      const n = 1679711644352
      const expectedEncoded = new Uint8Array([
        128, 171, 237, 233, 226, 97
      ])
      const encoded = encodeVarint(n)
      expect(encoded.length).to.equal(expectedEncoded.length)
      expect(encoded.every((val, i) => val === expectedEncoded[i])).to.true
      const toDecode = [...encoded, ...encoded]
      const [decoded, bytes] = decodeVarint(toDecode)
      expect(decoded).to.equal(n)
      expect(bytes.every((val, i) => val === expectedEncoded[i])).to.true
      const [decoded2, bytes2] = decodeVarint(bytes)
      expect(decoded2).to.equal(n)
      expect(bytes2).to.length(0)
    })
    it('encoding can be used to encode multiple numbers in a row', () => {
      const n1 = 1680535452135000
      const n2 = 1680535452178000
      const encodedN1 = encodeVarint(n1)
      const encodedN2 = encodeVarint(n2)
      const encoded = new Uint8Array(encodedN1.length + encodedN2.length)
      encoded.set(encodedN1)
      encoded.set(encodedN2, encodedN2.length)
      const [decodedN1, rest] = decodeVarint(encoded)
      const [decodedN2] = decodeVarint(rest)
      expect(decodedN1).to.equal(n1)
      expect(decodedN2).to.equal(n2)
    })
    it('encoding a number bigger than Max safe int fails.', () => {
      const n = Number.MAX_SAFE_INTEGER + 10
      const encoded = encodeVarint(n)
      expect(encoded).to.undefined
    })
  })
})
