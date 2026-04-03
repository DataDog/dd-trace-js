'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../setup/core')

const {
  computePathwayHash,
  encodePathwayContext,
  decodePathwayContext,
  encodePathwayContextBase64,
  decodePathwayContextBase64,
  DsmPathwayCodec,
} = require('../../src/datastreams/pathway')

describe('encoding', () => {
  it('hash should always give the same value', () => {
    // note: we use a different hash function than the one used in the other languages,
    // so if you switch language, the hash will change.
    // given the tag resolution we do on the backend, this is not a big issue.
    const hash = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'group:group1', 'topic:topic1', 'type:kafka'], Buffer.from('0000000000000000', 'hex'))
    assert.deepStrictEqual(hash, Buffer.from('67b0b35e65c0acfa', 'hex'))
  })

  it('hash should include propagation hash when provided', () => {
    const propagationHash = BigInt('0x123456789abcdef0')
    const hash1 = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'type:kafka'], Buffer.from('0000000000000000', 'hex'), propagationHash)
    const hash2 = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'type:kafka'], Buffer.from('0000000000000000', 'hex'), null)
    assert.notDeepStrictEqual(hash1, hash2, 'Hashes should differ with/without propagation hash')
  })

  it('hash should be consistent with same propagation hash', () => {
    const propagationHash = BigInt('0x123456789abcdef0')
    const hash1 = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'type:kafka'], Buffer.from('0000000000000000', 'hex'), propagationHash)
    const hash2 = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'type:kafka'], Buffer.from('0000000000000000', 'hex'), propagationHash)
    assert.deepStrictEqual(hash1, hash2, 'Same propagation hash should produce same pathway hash')
  })

  it('hash should differ with different propagation hashes', () => {
    const propagationHash1 = BigInt('0x123456789abcdef0')
    const propagationHash2 = BigInt('0xfedcba9876543210')
    const hash1 = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'type:kafka'], Buffer.from('0000000000000000', 'hex'), propagationHash1)
    const hash2 = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'type:kafka'], Buffer.from('0000000000000000', 'hex'), propagationHash2)
    assert.notDeepStrictEqual(hash1, hash2, 'Different propagation hashes should produce different pathway hashes')
  })

  it('encoding and decoding should be a no op', () => {
    const expectedContext = {
      hash: Buffer.from('67b0b35e65c0acfa', 'hex'),
      pathwayStartNs: 1685673482722000000,
      edgeStartNs: 1685673506404000000,
    }
    const encoded = encodePathwayContext(expectedContext)
    const decoded = decodePathwayContext(encoded)
    assert.strictEqual(decoded.hash.toString(), expectedContext.hash.toString())
    assert.strictEqual(decoded.pathwayStartNs, expectedContext.pathwayStartNs)
    assert.strictEqual(decoded.edgeStartNs, expectedContext.edgeStartNs)
  })

  it('decoding of a context should be consistent between languages', () => {
    const data = Buffer.from([103, 176, 179, 94, 101, 192, 172, 250, 196, 231,
      192, 159, 143, 98, 200, 217, 195, 159, 143, 98])
    const decoded = decodePathwayContext(data)
    const expectedContext = {
      hash: Buffer.from('67b0b35e65c0acfa', 'hex'),
      pathwayStartNs: 1685673482722000000,
      edgeStartNs: 1685673506404000000,
    }
    assert.strictEqual(decoded.hash.toString(), expectedContext.hash.toString())
    assert.strictEqual(decoded.pathwayStartNs, expectedContext.pathwayStartNs)
    assert.strictEqual(decoded.edgeStartNs, expectedContext.edgeStartNs)
  })

  it('should encode and decode to the same value when using base64', () => {
    const ctx = {
      pathwayStartNs: 1685673482722000000,
      edgeStartNs: 1685673506404000000,
    }
    ctx.hash = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'group:group1', 'topic:topic1', 'type:kafka'], Buffer.from('0000000000000000', 'hex'))

    const encodedPathway = encodePathwayContextBase64(ctx)
    const decodedPathway = decodePathwayContextBase64(encodedPathway)

    assert.strictEqual(decodedPathway.hash.toString(), ctx.hash.toString())
    assert.strictEqual(decodedPathway.pathwayStartNs, ctx.pathwayStartNs)
    assert.strictEqual(decodedPathway.edgeStartNs, ctx.edgeStartNs)
  })

  it('should encode and decode to the same value when using the PathwayCodec', () => {
    const ctx = {
      pathwayStartNs: 1685673482722000000,
      edgeStartNs: 1685673506404000000,
    }
    const carrier = {}
    ctx.hash = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'group:group1', 'topic:topic1', 'type:kafka'], Buffer.from('0000000000000000', 'hex'))

    DsmPathwayCodec.encode(ctx, carrier)
    const decodedCtx = DsmPathwayCodec.decode(carrier)

    assert.strictEqual(decodedCtx.hash.toString(), ctx.hash.toString())
    assert.strictEqual(decodedCtx.pathwayStartNs, ctx.pathwayStartNs)
    assert.strictEqual(decodedCtx.edgeStartNs, ctx.edgeStartNs)
  })

  it('should encode/decode to the same value when using the PathwayCodec, base64 and the deprecated ctx key', () => {
    const ctx = {
      pathwayStartNs: 1685673482722000000,
      edgeStartNs: 1685673506404000000,
    }
    const carrier = {}
    ctx.hash = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'group:group1', 'topic:topic1', 'type:kafka'], Buffer.from('0000000000000000', 'hex'))

    DsmPathwayCodec.encode(ctx, carrier)
    carrier['dd-pathway-ctx'] = carrier['dd-pathway-ctx-base64']
    delete carrier['dd-pathway-ctx-base64']
    const decodedCtx = DsmPathwayCodec.decode(carrier)

    assert.strictEqual(decodedCtx.hash.toString(), ctx.hash.toString())
    assert.strictEqual(decodedCtx.pathwayStartNs, ctx.pathwayStartNs)
    assert.strictEqual(decodedCtx.edgeStartNs, ctx.edgeStartNs)
  })

  it('should encode/decode to the same value when using the PathwayCodec and the deprecated encoding', () => {
    const ctx = {
      pathwayStartNs: 1685673482722000000,
      edgeStartNs: 1685673506404000000,
    }
    const carrier = {}
    ctx.hash = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'group:group1', 'topic:topic1', 'type:kafka'], Buffer.from('0000000000000000', 'hex'))

    carrier['dd-pathway-ctx'] = encodePathwayContext(ctx)
    const decodedCtx = DsmPathwayCodec.decode(carrier)

    assert.strictEqual(decodedCtx.hash.toString(), ctx.hash.toString())
    assert.strictEqual(decodedCtx.pathwayStartNs, ctx.pathwayStartNs)
    assert.strictEqual(decodedCtx.edgeStartNs, ctx.edgeStartNs)
  })

  it('should inject the base64 encoded string to the carrier', () => {
    const ctx = {
      pathwayStartNs: 1685673482722000000,
      edgeStartNs: 1685673506404000000,
    }
    const carrier = {}
    ctx.hash = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'group:group1', 'topic:topic1', 'type:kafka'], Buffer.from('0000000000000000', 'hex'))

    DsmPathwayCodec.encode(ctx, carrier)

    const expectedBase64Hash = 'Z7CzXmXArPrE58Cfj2LI2cOfj2I='
    assert.strictEqual(carrier['dd-pathway-ctx-base64'], expectedBase64Hash)
  })

  it('should extract the base64 encoded string from the carrier', () => {
    const ctx = {
      pathwayStartNs: 1685673482722000000,
      edgeStartNs: 1685673506404000000,
    }
    ctx.hash = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'group:group1', 'topic:topic1', 'type:kafka'], Buffer.from('0000000000000000', 'hex'))

    const carrier = {}
    const expectedBase64Hash = 'Z7CzXmXArPrE58Cfj2LI2cOfj2I='
    carrier['dd-pathway-ctx-base64'] = expectedBase64Hash
    const decodedCtx = DsmPathwayCodec.decode(carrier)

    assert.strictEqual(decodedCtx.hash.toString(), ctx.hash.toString())
  })
})
