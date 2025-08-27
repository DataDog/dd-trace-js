'use strict'

require('../setup/tap')

const { expect } = require('chai')
const {
  computePathwayHash,
  encodePathwayContext,
  decodePathwayContext,
  encodePathwayContextBase64,
  decodePathwayContextBase64,
  DsmPathwayCodec
} = require('../../src/datastreams/pathway')

describe('encoding', () => {
  it('hash should always give the same value', () => {
    // note: we use a different hash function than the one used in the other languages,
    // so if you switch language, the hash will change.
    // given the tag resolution we do on the backend, this is not a big issue.
    const hash = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'group:group1', 'topic:topic1', 'type:kafka'], Buffer.from('0000000000000000', 'hex'))
    expect(hash)
      .to.deep.equal(Buffer.from('67b0b35e65c0acfa', 'hex'))
  })

  it('encoding and decoding should be a no op', () => {
    const expectedContext = {
      hash: Buffer.from('67b0b35e65c0acfa', 'hex'),
      pathwayStartNs: 1685673482722000000,
      edgeStartNs: 1685673506404000000
    }
    const encoded = encodePathwayContext(expectedContext)
    const decoded = decodePathwayContext(encoded)
    expect(decoded.hash.toString()).to.equal(expectedContext.hash.toString())
    expect(decoded.pathwayStartNs).to.equal(expectedContext.pathwayStartNs)
    expect(decoded.edgeStartNs).to.equal(expectedContext.edgeStartNs)
  })

  it('decoding of a context should be consistent between languages', () => {
    const data = Buffer.from([103, 176, 179, 94, 101, 192, 172, 250, 196, 231,
      192, 159, 143, 98, 200, 217, 195, 159, 143, 98])
    const decoded = decodePathwayContext(data)
    const expectedContext = {
      hash: Buffer.from('67b0b35e65c0acfa', 'hex'),
      pathwayStartNs: 1685673482722000000,
      edgeStartNs: 1685673506404000000
    }
    expect(decoded.hash.toString()).to.equal(expectedContext.hash.toString())
    expect(decoded.pathwayStartNs).to.equal(expectedContext.pathwayStartNs)
    expect(decoded.edgeStartNs).to.equal(expectedContext.edgeStartNs)
  })

  it('should encode and decode to the same value when using base64', () => {
    const ctx = {
      pathwayStartNs: 1685673482722000000,
      edgeStartNs: 1685673506404000000
    }
    ctx.hash = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'group:group1', 'topic:topic1', 'type:kafka'], Buffer.from('0000000000000000', 'hex'))

    const encodedPathway = encodePathwayContextBase64(ctx)
    const decodedPathway = decodePathwayContextBase64(encodedPathway)

    expect(decodedPathway.hash.toString()).to.equal(ctx.hash.toString())
    expect(decodedPathway.pathwayStartNs).to.equal(ctx.pathwayStartNs)
    expect(decodedPathway.edgeStartNs).to.equal(ctx.edgeStartNs)
  })

  it('should encode and decode to the same value when using the PathwayCodec', () => {
    const ctx = {
      pathwayStartNs: 1685673482722000000,
      edgeStartNs: 1685673506404000000
    }
    const carrier = {}
    ctx.hash = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'group:group1', 'topic:topic1', 'type:kafka'], Buffer.from('0000000000000000', 'hex'))

    DsmPathwayCodec.encode(ctx, carrier)
    const decodedCtx = DsmPathwayCodec.decode(carrier)

    expect(decodedCtx.hash.toString()).to.equal(ctx.hash.toString())
    expect(decodedCtx.pathwayStartNs).to.equal(ctx.pathwayStartNs)
    expect(decodedCtx.edgeStartNs).to.equal(ctx.edgeStartNs)
  })

  it('should encode/decode to the same value when using the PathwayCodec, base64 and the deprecated ctx key', () => {
    const ctx = {
      pathwayStartNs: 1685673482722000000,
      edgeStartNs: 1685673506404000000
    }
    const carrier = {}
    ctx.hash = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'group:group1', 'topic:topic1', 'type:kafka'], Buffer.from('0000000000000000', 'hex'))

    DsmPathwayCodec.encode(ctx, carrier)
    carrier['dd-pathway-ctx'] = carrier['dd-pathway-ctx-base64']
    delete carrier['dd-pathway-ctx-base64']
    const decodedCtx = DsmPathwayCodec.decode(carrier)

    expect(decodedCtx.hash.toString()).to.equal(ctx.hash.toString())
    expect(decodedCtx.pathwayStartNs).to.equal(ctx.pathwayStartNs)
    expect(decodedCtx.edgeStartNs).to.equal(ctx.edgeStartNs)
  })

  it('should encode/decode to the same value when using the PathwayCodec and the deprecated encoding', () => {
    const ctx = {
      pathwayStartNs: 1685673482722000000,
      edgeStartNs: 1685673506404000000
    }
    const carrier = {}
    ctx.hash = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'group:group1', 'topic:topic1', 'type:kafka'], Buffer.from('0000000000000000', 'hex'))

    carrier['dd-pathway-ctx'] = encodePathwayContext(ctx)
    const decodedCtx = DsmPathwayCodec.decode(carrier)

    expect(decodedCtx.hash.toString()).to.equal(ctx.hash.toString())
    expect(decodedCtx.pathwayStartNs).to.equal(ctx.pathwayStartNs)
    expect(decodedCtx.edgeStartNs).to.equal(ctx.edgeStartNs)
  })

  it('should inject the base64 encoded string to the carrier', () => {
    const ctx = {
      pathwayStartNs: 1685673482722000000,
      edgeStartNs: 1685673506404000000
    }
    const carrier = {}
    ctx.hash = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'group:group1', 'topic:topic1', 'type:kafka'], Buffer.from('0000000000000000', 'hex'))

    DsmPathwayCodec.encode(ctx, carrier)

    const expectedBase64Hash = 'Z7CzXmXArPrE58Cfj2LI2cOfj2I='
    expect(carrier['dd-pathway-ctx-base64']).to.equal(expectedBase64Hash)
  })

  it('should extract the base64 encoded string from the carrier', () => {
    const ctx = {
      pathwayStartNs: 1685673482722000000,
      edgeStartNs: 1685673506404000000
    }
    ctx.hash = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'group:group1', 'topic:topic1', 'type:kafka'], Buffer.from('0000000000000000', 'hex'))

    const carrier = {}
    const expectedBase64Hash = 'Z7CzXmXArPrE58Cfj2LI2cOfj2I='
    carrier['dd-pathway-ctx-base64'] = expectedBase64Hash
    const decodedCtx = DsmPathwayCodec.decode(carrier)

    expect(decodedCtx.hash.toString()).to.equal(ctx.hash.toString())
  })
})
