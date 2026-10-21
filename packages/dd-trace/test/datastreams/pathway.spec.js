'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const { describe, it } = require('mocha')

require('../setup/core')

const { debugChannel } = require('../../src/log/channels')
const {
  computePathwayHash,
  encodePathwayContext,
  decodePathwayContext,
  encodePathwayContextBase64,
  decodePathwayContextBase64,
  DsmPathwayCodec,
} = require('../../src/datastreams/pathway')
const { PATHWAY_FIELD_BYTES } = require('../../src/datastreams/size')

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

  it('hash should always give the same value with a propagation hash and a non-zero parent hash', () => {
    const propagationHash = BigInt('0x123456789abcdef0')
    const hash = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'group:group1', 'topic:topic1', 'type:kafka'], Buffer.from('0102030405060708', 'hex'),
      propagationHash)
    assert.deepStrictEqual(hash, Buffer.from('14f85bd37aebd8a0', 'hex'))

    const hashWithRealParent = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'type:kafka'], Buffer.from('67b0b35e65c0acfa', 'hex'), propagationHash)
    assert.deepStrictEqual(hashWithRealParent, Buffer.from('bd5a8be5b8338501', 'hex'))
  })

  describe('cache', () => {
    function sha (input) {
      return Buffer.from(crypto.createHash('sha256').update(input).digest().subarray(0, 8))
    }

    function uncachedHash (service, env, edgeTags, parentHash, propagationHash = null) {
      const hashableEdgeTags = edgeTags.filter(tag => tag !== 'manual_checkpoint:true').sort()
      const baseString = `${service}${env}${hashableEdgeTags.join('')}`
      const hashInput = propagationHash ? `${baseString}:${propagationHash.toString(16)}` : baseString
      return sha(Buffer.concat([sha(hashInput), parentHash], 16).toString())
    }

    it('should equal the uncached computation for parents that differ only in non-UTF-8 bytes', () => {
      const edgeTags = ['direction:in', 'group:group1', 'topic:topic1', 'type:kafka']
      const parents = [
        '8000000000000000',
        '8100000000000000',
        'c000000000000000',
        'c100000000000000',
        'e000000000000000',
        'f000000000000000',
        'ffffffffffffffff',
        '00000000000000e0',
        '00000000000000e1',
        '00000000000000f0',
        '00000000000000f1',
      ].map(hex => Buffer.from(hex, 'hex'))

      for (const order of [parents, [...parents].reverse()]) {
        for (const propagationHash of [null, BigInt('0x123456789abcdef0')]) {
          for (const parent of order) {
            const expected = uncachedHash('test-service', 'test-env', edgeTags, parent, propagationHash)
            const actual = computePathwayHash('test-service', 'test-env', [...edgeTags], parent, propagationHash)
            assert.deepStrictEqual(actual, expected, `parent ${parent.toString('hex')}`)
          }
        }
      }
    })

    it('should equal the uncached computation when the current hash ends with a multibyte lead byte', () => {
      const parent = Buffer.from('8080808080808080', 'hex')
      let found = 0
      for (let i = 0; i < 2000 && found < 3; i++) {
        const edgeTags = ['direction:in', `topic:topic-${i}`, 'type:kafka']
        const hashInput = 'test-service' + 'test-env' + [...edgeTags].sort().join('')
        if (sha(hashInput)[7] < 0xc0) continue
        found++
        const expected = uncachedHash('test-service', 'test-env', edgeTags, parent)
        assert.deepStrictEqual(computePathwayHash('test-service', 'test-env', [...edgeTags], parent), expected)
        assert.deepStrictEqual(computePathwayHash('test-service', 'test-env', [...edgeTags], parent), expected)
      }
      assert.strictEqual(found, 3)
    })

    it('should return the same buffer on repeated calls', () => {
      const parent = Buffer.from('0000000000000001', 'hex')
      const first = computePathwayHash('test-service', 'test-env', ['direction:out', 'type:kafka'], parent)
      const second = computePathwayHash('test-service', 'test-env', ['direction:out', 'type:kafka'], parent)
      assert.strictEqual(second, first)
    })

    it('should ignore manual_checkpoint:true in the hash and sort the caller edge tags in place', () => {
      const parent = Buffer.from('0000000000000000', 'hex')
      const withManual = ['type:kafka', 'manual_checkpoint:true', 'direction:in']
      const withoutManual = ['type:kafka', 'direction:in']

      const manualHash = computePathwayHash('test-service', 'test-env', withManual, parent)
      const plainHash = computePathwayHash('test-service', 'test-env', withoutManual, parent)

      assert.deepStrictEqual(manualHash, plainHash)
      assert.deepStrictEqual(manualHash, uncachedHash('test-service', 'test-env', withManual, parent))
      assert.deepStrictEqual(withManual, ['direction:in', 'manual_checkpoint:true', 'type:kafka'])
      assert.deepStrictEqual(withoutManual, ['direction:in', 'type:kafka'])
    })

    it('should treat a zero propagation hash as absent', () => {
      const parent = Buffer.from('0000000000000000', 'hex')
      const withZero = computePathwayHash('test-service', 'test-env', ['direction:in'], parent, 0n)
      const withNull = computePathwayHash('test-service', 'test-env', ['direction:in'], parent, null)
      assert.deepStrictEqual(withZero, withNull)
    })

    it('should stay correct after more than 500 distinct parents and recomputation after a clear', () => {
      const edgeTags = ['direction:in', 'group:eviction', 'topic:eviction', 'type:kafka']
      const parents = []
      for (let i = 0; i < 1200; i++) {
        const parent = Buffer.alloc(8)
        parent.writeUInt32BE(i * 7919, 4)
        parent[0] = 0x80 + (i % 64)
        parents.push(parent)
      }

      for (let round = 0; round < 2; round++) {
        for (const parent of parents) {
          const expected = uncachedHash('test-service', 'test-env', edgeTags, parent)
          assert.deepStrictEqual(computePathwayHash('test-service', 'test-env', [...edgeTags], parent), expected)
        }
      }
    })

    it('should leave the caller edge tags in the order sort() would and match the uncached computation', () => {
      const parent = Buffer.from('0000000000000000', 'hex')
      const inputs = [
        ['type:kafka', 'direction:in', 'topic:a'],
        ['direction:in', 'topic:a', 'type:kafka'],
        ['type:kafka', 'topic:a', 'direction:in'],
        ['direction:in', 'topic:a', 'topic:a', 'type:kafka'],
        ['type:kafka', 'topic:a', 'topic:a', 'direction:in'],
        ['a:1', 'Z:1'],
        ['Z:1', 'a:1'],
        ['\u{1F600}', '\uFFFF'],
        ['\uFFFF', '\u{1F600}'],
      ]

      for (const input of inputs) {
        for (let pass = 0; pass < 2; pass++) {
          const edgeTags = [...input]
          const actual = computePathwayHash('test-service', 'test-env', edgeTags, parent)
          assert.deepStrictEqual(edgeTags, [...input].sort())
          assert.deepStrictEqual(actual, uncachedHash('test-service', 'test-env', input, parent))
        }
      }
    })

    it('should not share a cache entry between tag sequences that join to the same string', () => {
      const parent = Buffer.from('0000000000000000', 'hex')
      const sequences = [['ab', 'c'], ['a', 'bc'], ['direction:in'], ['direction:in', 'type:kafka']]

      for (const order of [sequences, [...sequences].reverse()]) {
        for (const tags of order) {
          const expected = uncachedHash('test-service', 'test-env', tags, parent)
          assert.deepStrictEqual(computePathwayHash('test-service', 'test-env', [...tags], parent), expected)
        }
      }
    })

    it('should not share a cache entry between an undefined and an "undefined" service or env', () => {
      const parent = Buffer.from('0000000000000000', 'hex')
      const tags = ['direction:in', 'type:kafka']
      const pairs = [
        [undefined, 'test-env'],
        ['undefined', 'test-env'],
        ['test-service', undefined],
        ['test-service', 'undefined'],
      ]

      for (const order of [pairs, [...pairs].reverse()]) {
        for (const [service, env] of order) {
          const expected = uncachedHash(service, env, tags, parent)
          assert.deepStrictEqual(computePathwayHash(service, env, [...tags], parent), expected)
        }
      }
    })

    it('should keep null, zero and distinct propagation hashes on the same tags apart', () => {
      const parent = Buffer.from('0000000000000000', 'hex')
      const tags = ['direction:in', 'type:kafka']
      const propagationHashes = [null, 0n, 1n, BigInt('0x123456789abcdef0')]

      for (const order of [propagationHashes, [...propagationHashes].reverse()]) {
        for (const propagationHash of order) {
          const expected = uncachedHash('test-service', 'test-env', tags, parent, propagationHash)
          assert.deepStrictEqual(
            computePathwayHash('test-service', 'test-env', [...tags], parent, propagationHash),
            expected
          )
        }
      }
    })

    it('should stay correct after more than 500 distinct edge tag sets and recomputation after a clear', () => {
      const parent = Buffer.from('0000000000000001', 'hex')

      for (let round = 0; round < 2; round++) {
        for (let i = 0; i < 1200; i++) {
          const edgeTags = ['direction:in', `topic:topic-${i}`, 'type:kafka']
          const expected = uncachedHash('test-service', 'test-env', edgeTags, parent)
          assert.deepStrictEqual(computePathwayHash('test-service', 'test-env', [...edgeTags], parent), expected)
        }
      }
    })
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

  describe('base64 encode memo', () => {
    const pathwayStartNs = 1685673482722000000
    const edgeStartNs = 1685673506404000000

    function reference (ctx) {
      return encodePathwayContext(ctx).toString('base64')
    }

    function withHash (bytes, overrides) {
      return { hash: Buffer.from(bytes, 'hex'), pathwayStartNs, edgeStartNs, ...overrides }
    }

    it('should match the unmemoized encoding for repeated and changed contexts', () => {
      const contexts = [
        withHash('67b0b35e65c0acfa'),
        withHash('67b0b35e65c0acfa'),
        withHash('66b0b35e65c0acfa'),
        withHash('67b0b35e65c0acfb'),
        withHash('67b0b35e65c0acfb', { pathwayStartNs: pathwayStartNs + 1e6 }),
        withHash('67b0b35e65c0acfb', { pathwayStartNs: pathwayStartNs + 1e6, edgeStartNs: edgeStartNs + 1e6 }),
        withHash('67b0b35e65c0acfb', { pathwayStartNs: pathwayStartNs + 1e6, edgeStartNs: edgeStartNs + 1e6 }),
        withHash('67b0b35e65c0acfa'),
        withHash('67b0b35e65c0acfa', { pathwayStartNs: -0, edgeStartNs: 0 }),
        withHash('67b0b35e65c0acfa', { pathwayStartNs: 0, edgeStartNs: -0 }),
        withHash('67b0b35e65c0acfa', { pathwayStartNs: Number.MAX_SAFE_INTEGER * 1e6, edgeStartNs }),
        withHash('67b0b35e65c0acfa'),
      ]
      for (const ctx of contexts) {
        assert.strictEqual(encodePathwayContextBase64(ctx), reference(ctx))
      }
    })

    it('should return the same string for sub-millisecond changes that round to the same millisecond', () => {
      const first = withHash('67b0b35e65c0acfa')
      const second = withHash('67b0b35e65c0acfa', {
        pathwayStartNs: pathwayStartNs + 4e5,
        edgeStartNs: edgeStartNs - 4e5,
      })
      const third = withHash('67b0b35e65c0acfa', { pathwayStartNs: pathwayStartNs + 6e5 })

      assert.strictEqual(encodePathwayContextBase64(first), reference(first))
      assert.strictEqual(encodePathwayContextBase64(second), reference(second))
      assert.strictEqual(reference(second), reference(first))
      assert.strictEqual(encodePathwayContextBase64(third), reference(third))
      assert.notStrictEqual(reference(third), reference(first))
    })

    it('should match the unmemoized encoding for a NaN timestamp before and after a memoized context', () => {
      const valid = withHash('67b0b35e65c0acfa')
      const invalid = withHash('67b0b35e65c0acfa', { edgeStartNs: Number.NaN })

      assert.strictEqual(encodePathwayContextBase64(valid), reference(valid))
      assert.strictEqual(encodePathwayContextBase64(invalid), reference(invalid))
      assert.strictEqual(encodePathwayContextBase64(invalid), reference(invalid))
      assert.strictEqual(encodePathwayContextBase64(valid), reference(valid))
    })

    it('should encode the new bytes after the same hash buffer is mutated in place', () => {
      const ctx = withHash('67b0b35e65c0acfa')
      const before = encodePathwayContextBase64(ctx)
      ctx.hash[7] = 0x01
      const after = encodePathwayContextBase64(ctx)

      assert.strictEqual(before, reference(withHash('67b0b35e65c0acfa')))
      assert.strictEqual(after, reference(withHash('67b0b35e65c0ac01')))
      assert.notStrictEqual(after, before)
    })

    it('should match the unmemoized encoding for hashes that are not 8 bytes long', () => {
      const ctx = withHash('67b0b35e65c0acfa')
      const long = withHash('67b0b35e65c0acfa0102')
      const short = withHash('67b0b35e')

      assert.strictEqual(encodePathwayContextBase64(ctx), reference(ctx))
      assert.strictEqual(encodePathwayContextBase64(long), reference(long))
      assert.strictEqual(encodePathwayContextBase64(short), reference(short))
      assert.strictEqual(encodePathwayContextBase64(ctx), reference(ctx))
    })
  })

  describe('base64 decode memo', () => {
    const valid = 'Z7CzXmXArPrE58Cfj2LI2cOfj2I='
    const other = encodePathwayContextBase64({
      hash: Buffer.from('0102030405060708', 'hex'),
      pathwayStartNs: 1685673482723000000,
      edgeStartNs: 1685673506405000000,
    })
    // 8 hash bytes followed by a varint that never terminates
    const truncated = Buffer.concat([Buffer.alloc(8), Buffer.from([0x80, 0x80])]).toString('base64')

    function reference (input) {
      if (input == null || input.length < 8) return
      const text = Buffer.isBuffer(input) ? input.toString() : input
      return decodePathwayContext(Buffer.from(text, 'base64'))
    }

    it('should match the unmemoized decoding for repeated, alternating and invalid inputs', () => {
      const inputs = [
        valid, valid, other, valid, other, other,
        Buffer.from(valid), valid, undefined, null, 'short', '', truncated, truncated, '!!!!!!!!!!!!', valid,
      ]
      for (const input of inputs) {
        assert.deepStrictEqual(decodePathwayContextBase64(input), reference(input))
      }
    })

    it('should return null, not undefined, for an invalid context of sufficient length', () => {
      assert.strictEqual(decodePathwayContextBase64(truncated), null)
      assert.strictEqual(decodePathwayContextBase64(truncated), null)
    })

    it('should return a new object on every call', () => {
      const first = decodePathwayContextBase64(valid)
      const second = decodePathwayContextBase64(valid)

      assert.deepStrictEqual(second, first)
      assert.notStrictEqual(second, first)
    })

    it('should not leak a caller mutation into the next decode', () => {
      const first = decodePathwayContextBase64(valid)
      first.pathwayStartNs = 1
      first.edgeStartNs = 2
      first.extra = true

      assert.deepStrictEqual(decodePathwayContextBase64(valid), reference(valid))
    })
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

    const injectedCarrier = DsmPathwayCodec.encode(ctx, carrier)

    assert.strictEqual(injectedCarrier, carrier)
    const expectedBase64Hash = 'Z7CzXmXArPrE58Cfj2LI2cOfj2I='
    assert.strictEqual(carrier['dd-pathway-ctx-base64'], expectedBase64Hash)
  })

  it('lazily creates and returns a carrier', () => {
    const context = {
      pathwayStartNs: 1685673482722000000,
      edgeStartNs: 1685673482722000000,
      hash: computePathwayHash('test-service', 'test-env',
        ['direction:in', 'group:group1', 'topic:topic1', 'type:kafka'], Buffer.from('0000000000000000', 'hex')),
    }

    const carrier = DsmPathwayCodec.encode(context)

    assert.ok(carrier)
    assert.strictEqual(typeof carrier['dd-pathway-ctx-base64'], 'string')
  })

  it('decodes a message that has no carrier while debug logging is active', () => {
    const subscriber = () => {}
    debugChannel.subscribe(subscriber)

    try {
      assert.strictEqual(DsmPathwayCodec.decode(undefined), undefined)
    } finally {
      debugChannel.unsubscribe(subscriber)
    }
  })

  it('should encode to the JSON field size producers reserve as PATHWAY_FIELD_BYTES', () => {
    const nowNs = Date.now() * 1e6
    const ctx = {
      hash: computePathwayHash('test-service', 'test-env',
        ['direction:out', 'type:eventbridge'], Buffer.from('0000000000000000', 'hex')),
      pathwayStartNs: nowNs,
      edgeStartNs: nowNs,
    }

    const [key, value] = Object.entries(DsmPathwayCodec.encode(ctx))[0]

    assert.strictEqual(Buffer.byteLength(`,${JSON.stringify(key)}:${JSON.stringify(value)}`), PATHWAY_FIELD_BYTES)
  })

  it('returns undefined when the pathway context has no hash', () => {
    const contextWithoutHash = /** @type {{ hash: Buffer, pathwayStartNs: number, edgeStartNs: number }} */ ({})

    assert.strictEqual(DsmPathwayCodec.encode(contextWithoutHash), undefined)
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

  it('should resolve a repeated base64 pathway field to the last one', () => {
    const carrier = {
      'dd-pathway-ctx-base64': ['pgeYnLTHrPrE58Cfj2LI2cOfj2I=', 'Z7CzXmXArPrE58Cfj2LI2cOfj2I='],
    }

    const decodedCtx = DsmPathwayCodec.decode(carrier)

    const expectedHash = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'group:group1', 'topic:topic1', 'type:kafka'], Buffer.from('0000000000000000', 'hex'))
    assert.strictEqual(decodedCtx.hash.toString(), expectedHash.toString())
  })

  it('should resolve a repeated deprecated pathway field to the last one', () => {
    const ctx = {
      pathwayStartNs: 1685673482722000000,
      edgeStartNs: 1685673506404000000,
      hash: computePathwayHash('test-service', 'test-env',
        ['direction:in', 'group:group1', 'topic:topic1', 'type:kafka'], Buffer.from('0000000000000000', 'hex')),
    }
    const carrier = {
      'dd-pathway-ctx': ['Z7CzXmXArPrE58Cfj2LI2cOfj2I=', encodePathwayContextBase64(ctx)],
    }

    const decodedCtx = DsmPathwayCodec.decode(carrier)

    assert.strictEqual(decodedCtx.hash.toString(), ctx.hash.toString())
    assert.strictEqual(decodedCtx.pathwayStartNs, ctx.pathwayStartNs)
    assert.strictEqual(decodedCtx.edgeStartNs, ctx.edgeStartNs)
  })

  it('returns undefined when the carrier has no pathway field', () => {
    assert.strictEqual(DsmPathwayCodec.decode({}), undefined)
  })
})
