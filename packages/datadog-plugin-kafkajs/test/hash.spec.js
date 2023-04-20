'use strict'

const { getConnectionHash, getPathwayHash, encodePathwayContext, decodePathwayContext } = require('../src/hash')
const { expect } = require('chai')

describe('hashing', () => {
  describe('getConnectionHash', () => {
    it('gets connection hash from checkpoint string', () => {
      const checkpointString = 'unnamed-go-servicetype:kafka'
      const expectedHash = Buffer.from('c223f2fa96760cba', 'hex')
      const hash = getConnectionHash(checkpointString)
      expect(hash.length).to.equal(expectedHash.length)
      for (let i = 0; i < expectedHash.length; i++) {
        expect(hash[i]).to.equal(expectedHash[i])
      }
    })
  })
  describe('getPathwayHash', () => {
    it('gets pathway hash from connection string and parent hash', () => {
      const parentHash = Buffer.from('0000000000000000', 'hex')
      const currentHash = Buffer.from('c223f2fa96760cba', 'hex')
      const expectedHash = Buffer.from('e073ca23a5577149', 'hex') // TODO
      const hash = getPathwayHash(parentHash, currentHash)
      expect(hash.length).to.equal(expectedHash.length)
      for (let i = 0; i < expectedHash.length; i++) {
        expect(hash[i]).to.equal(expectedHash[i])
      }
    })
  })
})
describe('encoding', () => {
  it('encodes then decodes pathway context', () => {
    const pathwayHash = Buffer.from('e073ca23a5577149', 'hex')
    const timestamp = 1680033770000
    const expectedEncoded = Buffer.from('e073ca23a5577149a0a8879de561a0a8879de561', 'hex')
    const encoded = encodePathwayContext(pathwayHash, timestamp, timestamp)
    expect(encoded.length).to.equal(expectedEncoded.length)
    for (let i = 0; i < expectedEncoded.length; i++) {
      expect(encoded[i]).to.equal(expectedEncoded[i])
    }

    const [ decodedPathwayHash, decodedTimeSinceOrigin, decodedTimeSincePrev ] = decodePathwayContext(encoded)
    expect(decodedPathwayHash.length).to.equal(pathwayHash.length)
    for (let i = 0; i < pathwayHash.length; i++) {
      expect(decodedPathwayHash[i]).to.equal(pathwayHash[i])
    }
    expect(decodedTimeSinceOrigin).to.equal(timestamp)
    expect(decodedTimeSincePrev).to.equal(timestamp)
  })
})
