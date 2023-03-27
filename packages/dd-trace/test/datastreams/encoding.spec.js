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
      const decoded = decodeVarint(encoded)
      expect(decoded).to.equal(n)
    })
    it('encoding then decoding should be a no op for bigger than int32 numbers', () => {
      const n = 1679711644352
      const expectedEncoded = new Uint8Array([
        128, 171, 237, 233, 226, 97
      ])
      const encoded = encodeVarint(n)
      expect(encoded.length).to.equal(expectedEncoded.length)
      expect(encoded.every((val, i) => val === expectedEncoded[i])).to.true
      const decoded = decodeVarint(encoded)
      expect(decoded).to.equal(n)
    })
    it('encoding a number bigger than Max safe int fails.', () => {
      const n = Number.MAX_SAFE_INTEGER + 10
      const encoded = encodeVarint(n)
      expect(encoded).to.undefined
    })
  })
})
