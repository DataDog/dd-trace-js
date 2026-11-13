'use strict'

const assert = require('node:assert/strict')

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
    const hash = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'group:group1', 'topic:topic1', 'type:kafka'], Buffer.from('0000000000000000', 'hex'))
    // Expected hash comes from dd-trace-java's FNV64Hash.
    assert.strictEqual(hash.toString('hex'), '43ac630dffaa73de')
  })

  it('encoding and decoding should be a no op', () => {
    const expectedContext = {
      hash: Buffer.from('67b0b35e65c0acfa', 'hex'),
      pathwayStartNs: 1685673482722000000,
      edgeStartNs: 1685673506404000000,
    }
    const encoded = encodePathwayContext(expectedContext)
    const decoded = decodePathwayContext(encoded)
    assert.strictEqual(decoded.hash.toString('hex'), expectedContext.hash.toString('hex'))
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
    assert.strictEqual(decoded.hash.toString('hex'), expectedContext.hash.toString('hex'))
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

    assert.strictEqual(decodedPathway.hash.toString('hex'), ctx.hash.toString('hex'))
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

    assert.strictEqual(decodedCtx.hash.toString('hex'), ctx.hash.toString('hex'))
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

    assert.strictEqual(decodedCtx.hash.toString('hex'), ctx.hash.toString('hex'))
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

    assert.strictEqual(decodedCtx.hash.toString('hex'), ctx.hash.toString('hex'))
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
    // Expected header is dd-trace-java's DefaultPathwayContext encoding of its FNV64Hash for the same checkpoint.
    const expectedBase64Hash = 'Q6xjDf+qc97E58Cfj2LI2cOfj2I='
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
    // Header is dd-trace-java's DefaultPathwayContext encoding of its FNV64Hash for the same checkpoint.
    const expectedBase64Hash = 'Q6xjDf+qc97E58Cfj2LI2cOfj2I='
    carrier['dd-pathway-ctx-base64'] = expectedBase64Hash
    const decodedCtx = DsmPathwayCodec.decode(carrier)

    assert.strictEqual(decodedCtx.hash.toString('hex'), ctx.hash.toString('hex'))
  })

  it('should resolve a repeated base64 pathway field to the last one', () => {
    // The last header is dd-trace-java's DefaultPathwayContext encoding of its FNV64Hash for the same checkpoint.
    const carrier = {
      'dd-pathway-ctx-base64': ['pgeYnLTHrPrE58Cfj2LI2cOfj2I=', 'Q6xjDf+qc97E58Cfj2LI2cOfj2I='],
    }

    const decodedCtx = DsmPathwayCodec.decode(carrier)

    const expectedHash = computePathwayHash('test-service', 'test-env',
      ['direction:in', 'group:group1', 'topic:topic1', 'type:kafka'], Buffer.from('0000000000000000', 'hex'))
    assert.strictEqual(decodedCtx.hash.toString('hex'), expectedHash.toString('hex'))
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

    assert.strictEqual(decodedCtx.hash.toString('hex'), ctx.hash.toString('hex'))
    assert.strictEqual(decodedCtx.pathwayStartNs, ctx.pathwayStartNs)
    assert.strictEqual(decodedCtx.edgeStartNs, ctx.edgeStartNs)
  })

  it('returns undefined when the carrier has no pathway field', () => {
    assert.strictEqual(DsmPathwayCodec.decode({}), undefined)
  })
})

describe('computePathwayHash', () => {
  /**
   * @param {bigint} value
   * @returns {Buffer} The uint64 as the 8 little-endian bytes dd-pathway-ctx carries.
   */
  function u64 (value) {
    const buf = Buffer.alloc(8)
    buf.writeBigUInt64LE(value)
    return buf
  }

  /**
   * @param {string} service
   * @param {string | undefined} env
   * @param {string[]} edgeTags
   * @param {bigint} parent
   * @param {string} [processTags]
   * @param {string} [containerTagsHash]
   */
  function hashOf (service, env, edgeTags, parent, processTags, containerTagsHash) {
    return computePathwayHash(service, env, [...edgeTags], u64(parent), processTags, containerTagsHash)
      .readBigUInt64LE()
  }

  describe('matches dd-trace-java for the same checkpoint', () => {
    // Expected hashes come from dd-trace-java's FNV64Hash, BaseHash and DataStreamsTags (process tags off).
    /** @type {Array<[string, string, string | undefined, string[], bigint, bigint]>} */
    const javaVectors = [
      ['http out, root', 'service-a', 'test', ['direction:out', 'type:http'], 0n, 11849898521937609503n],
      ['http in', 'service-b', 'test', ['direction:in', 'type:http'], 11849898521937609503n, 11291553564431990061n],
      ['http in, root', 'service-b', 'test', ['direction:in', 'type:http'], 0n, 11375375775841093325n],
      ['kafka out after http in', 'service-b', 'test',
        ['direction:out', 'topic:T', 'type:kafka'], 11291553564431990061n, 6144316448857745107n],
      ['http out after http in', 'service-b', 'test',
        ['direction:out', 'type:http'], 11291553564431990061n, 1707038938570633554n],
      ['kafka in after kafka out', 'service-c', 'test',
        ['direction:in', 'group:G', 'topic:T', 'type:kafka'], 6144316448857745107n, 11852442102485886382n],
      ['http out after kafka in', 'service-c', 'test',
        ['direction:out', 'type:http'], 11852442102485886382n, 2531161856314551922n],
      ['kafka_cluster_id is hashed after type', 'service-b', 'test',
        ['direction:out', 'kafka_cluster_id:cluster-1', 'topic:T', 'type:kafka'], 11291553564431990061n,
        3389071276614645164n],
      ['kafka_cluster_id is hashed after type, group is not hashed', 'svc', 'prod',
        ['direction:in', 'group:G', 'kafka_cluster_id:cluster-1', 'topic:T', 'type:kafka'], 6144316448857745107n,
        4836876666299323085n],
      ['bus is hashed first', 'svc', 'prod', ['bus:B', 'direction:out', 'type:bus'], 0n, 7175863279582014752n],
      ['exchange is hashed before topic', 'svc', 'prod',
        ['direction:out', 'exchange:E', 'topic:T', 'type:eventbridge'], 0n, 4511192404301554690n],
      ['subscription is hashed after type', 'svc', 'prod',
        ['direction:in', 'subscription:S', 'topic:T', 'type:google-pubsub'], 0n, 27121900556120704n],
      ['group is not hashed', 'svc', 'prod',
        ['direction:in', 'group:G', 'topic:T', 'type:kafka'], 0n, 2895804592055003988n],
      ['consumer_group is not hashed', 'svc', 'prod',
        ['consumer_group:CG', 'direction:in', 'topic:T', 'type:kafka'], 0n, 2895804592055003988n],
      ['partition is not hashed', 'svc', 'prod',
        ['direction:out', 'partition:3', 'topic:T', 'type:kafka'], 0n, 10647139169454223078n],
      ['manual_checkpoint is not hashed', 'svc', 'prod',
        ['direction:out', 'manual_checkpoint:true', 'topic:T', 'type:kafka'], 0n, 10647139169454223078n],
      ['ds.name is not hashed', 'svc', 'prod',
        ['direction:out', 'ds.name:D', 'topic:bucket', 'type:s3'], 0n, 4447754479120872799n],
      ['ds.namespace is not hashed', 'svc', 'prod',
        ['direction:out', 'ds.namespace:N', 'topic:bucket', 'type:s3'], 0n, 4447754479120872799n],
      ['has_routing_key:true is not hashed', 'svc', 'prod',
        ['direction:out', 'exchange:ex', 'has_routing_key:true', 'type:rabbitmq'], 0n, 13753374473702691174n],
      ['has_routing_key:false is not hashed', 'svc', 'prod',
        ['direction:out', 'exchange:ex', 'has_routing_key:false', 'type:rabbitmq'], 0n, 13753374473702691174n],
      ['every tag Java knows, hashed ones in Java order', 'svc', 'prod',
        ['bus:B', 'consumer_group:CG', 'direction:out', 'ds.name:D', 'ds.namespace:N', 'exchange:E', 'group:G',
          'has_routing_key:true', 'kafka_cluster_id:K', 'manual_checkpoint:true', 'partition:3', 'subscription:S',
          'topic:T', 'type:kafka'], 0n, 7731360346932091050n],
      ['unset env hashes as the empty string', 'svc', undefined,
        ['direction:out', 'topic:T', 'type:kafka'], 0n, 9268982801090271088n],
    ]

    for (const [name, service, env, edgeTags, parent, expected] of javaVectors) {
      it(name, () => {
        assert.strictEqual(hashOf(service, env, edgeTags, parent), expected)
      })
    }
  })

  describe('matches dd-trace-java with process tags on', () => {
    const processTags = 'entrypoint.basedir:src,entrypoint.name:server,entrypoint.type:script,' +
      'entrypoint.workdir:orders,package.json.name:orders-api,svc.user:true'
    const kafkaOut = ['direction:out', 'topic:T', 'type:kafka']

    // Expected hashes come from dd-trace-java's FNV64Hash, BaseHash and DataStreamsTags with these process tags.
    it('folds process tags, then the container tags hash, after env', () => {
      assert.strictEqual(hashOf('svc', 'prod', kafkaOut, 0n, processTags, 'c0ffee1234567890'), 15564134290263117538n)
    })

    it('folds them into the node hash, before the parent is combined', () => {
      const edgeTags = ['direction:in', 'group:G', 'topic:T', 'type:kafka']
      assert.strictEqual(
        hashOf('svc', 'prod', edgeTags, 6144316448857745107n, processTags, 'c0ffee1234567890'),
        3797417154548423499n
      )
    })

    it('folds process tags alone when there is no container tags hash', () => {
      assert.strictEqual(hashOf('svc', 'prod', kafkaOut, 0n, processTags), 5358252982993530837n)
      assert.strictEqual(hashOf('svc', 'prod', kafkaOut, 0n, processTags, ''), 5358252982993530837n)
    })

    it('ignores the container tags hash without process tags', () => {
      assert.strictEqual(hashOf('svc', 'prod', kafkaOut, 0n, undefined, 'c0ffee1234567890'), 10647139169454223078n)
    })
  })

  describe('matches the dd-trace-java hashes system-tests asserts', () => {
    // Expected hashes are the constants tests/integrations/test_dsm.py asserts for dd-trace-java (compute_dsm_hash).
    /** @type {Array<[string, string[], bigint, bigint]>} */
    const systemTestsVectors = [
      ['Test_DsmHttp', ['direction:in', 'type:http'], 0n, 3883033147046472598n],
      ['Test_DsmContext_Injection_Base64',
        ['direction:out', 'topic:dsm-injection-topic', 'type:kafka'], 0n, 6031446427375485596n],
      ['Test_DsmContext_Extraction_Base64',
        ['direction:in', 'topic:dsm-injection-topic', 'type:kafka'], 6031446427375485596n, 12795903374559614717n],
      ['Test_Dsm_Manual_Checkpoint_Intra_Process produce',
        ['direction:out', 'type:dd-streams', 'topic:system-tests-queue', 'manual_checkpoint:true'],
        3883033147046472598n, 1538441441403845096n],
      ['Test_Dsm_Manual_Checkpoint_Intra_Process consume',
        ['direction:in', 'type:dd-streams', 'topic:system-tests-queue', 'manual_checkpoint:true'],
        1538441441403845096n, 17074055019471758954n],
    ]

    for (const [name, edgeTags, parent, expected] of systemTestsVectors) {
      it(name, () => {
        assert.strictEqual(hashOf('weblog', 'system-tests', edgeTags, parent), expected)
      })
    }
  })

  it('hashes tag keys dd-trace-java does not know after its own, alphabetically', () => {
    const edgeTags = ['zzz:2', 'direction:out', 'topic:T', 'aaa:1', 'type:kafka']
    // Expected hash continues dd-trace-java's node hash with FNV64Hash.continueHash("aaa:1") then ("zzz:2").
    assert.strictEqual(hashOf('svc', 'prod', edgeTags, 0n), 6818286502399933828n)
  })

  describe('parent hash', () => {
    const edgeTags = ['direction:in', 'topic:t', 'type:kafka']

    it('gives distinct children to parents that only differ in bytes that are not valid UTF-8', () => {
      const childOfFf = computePathwayHash('svc-utf8', 'env', [...edgeTags], Buffer.from('ff00000000000001', 'hex'))
      const childOfFe = computePathwayHash('svc-utf8', 'env', [...edgeTags], Buffer.from('fe00000000000001', 'hex'))

      assert.notStrictEqual(childOfFf.toString('hex'), childOfFe.toString('hex'))
    })

    it('gives every distinct parent in a seeded sample a distinct child', () => {
      // xorshift32 with a fixed seed, so every run hashes the same parents.
      let state = 1
      const next = () => {
        state ^= state << 13
        state ^= state >>> 17
        state ^= state << 5
        return state >>> 0
      }
      const parents = new Set()
      while (parents.size < 10_000) {
        const parent = Buffer.alloc(8)
        parent.writeUInt32LE(next(), 0)
        parent.writeUInt32LE(next(), 4)
        parents.add(parent.toString('hex'))
      }

      const children = new Set()
      for (const parent of parents) {
        children.add(computePathwayHash('svc-sample', 'env', edgeTags, Buffer.from(parent, 'hex')).toString('hex'))
      }

      assert.strictEqual(children.size, parents.size)
    })
  })

  describe('cache', () => {
    it('serves a cached hash only for the same inputs', () => {
      const edgeTags = ['direction:in', 'topic:t', 'type:kafka']
      const first = computePathwayHash('svc-cache', 'env-cache', [...edgeTags], Buffer.from('ff00000000000001', 'hex'))
      const other = computePathwayHash('svc-cache', 'env-cache', [...edgeTags], Buffer.from('fe00000000000001', 'hex'))
      const again = computePathwayHash('svc-cache', 'env-cache',
        ['type:kafka', 'direction:in', 'topic:t'], Buffer.from('ff00000000000001', 'hex'))

      assert.notStrictEqual(other, first, 'a different parent was served the cached hash of another parent')
      // Expected hashes come from dd-trace-java's FNV64Hash.
      assert.strictEqual(first.readBigUInt64LE(), 16494264814562141125n)
      assert.strictEqual(other.readBigUInt64LE(), 12266083548423206558n)
      // StatsBucket keys stats points by the hash Buffer, so equal inputs must return the same instance.
      assert.strictEqual(again, first)
    })

    it('serves a cached hash only for the same process tags and container tags hash', () => {
      const processTags = 'entrypoint.basedir:src,entrypoint.name:server,entrypoint.type:script,' +
        'entrypoint.workdir:orders,package.json.name:orders-api,svc.user:true'
      const kafkaOut = ['direction:out', 'topic:T', 'type:kafka']
      const root = Buffer.alloc(8)

      const off = computePathwayHash('svc', 'prod', [...kafkaOut], root)
      const on = computePathwayHash('svc', 'prod', [...kafkaOut], root, processTags)
      const onWithContainer = computePathwayHash('svc', 'prod', [...kafkaOut], root, processTags, 'c0ffee1234567890')
      const offAgain = computePathwayHash('svc', 'prod', [...kafkaOut], root)

      // Expected hashes come from dd-trace-java's FNV64Hash, BaseHash and DataStreamsTags.
      assert.strictEqual(off.readBigUInt64LE(), 10647139169454223078n)
      assert.strictEqual(on.readBigUInt64LE(), 5358252982993530837n)
      assert.strictEqual(onWithContainer.readBigUInt64LE(), 15564134290263117538n)
      assert.strictEqual(offAgain, off)
    })
  })
})
