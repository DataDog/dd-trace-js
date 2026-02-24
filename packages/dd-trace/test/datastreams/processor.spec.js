'use strict'

const assert = require('node:assert/strict')
const { hostname } = require('node:os')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')
const { LogCollapsingLowestDenseDDSketch } = require('../../../../vendor/dist/@datadog/sketches-js')

const HIGH_ACCURACY_DISTRIBUTION = 0.0075

const pkg = require('../../../../package.json')
const DEFAULT_TIMESTAMP = Number(new Date('2023-04-20T16:20:00.000Z'))
const DEFAULT_LATENCY = 100000000
const DEFAULT_PARENT_HASH = Buffer.from('e858292fd15a41e4', 'hex')
const ANOTHER_PARENT_HASH = Buffer.from('e858292fd15a4100', 'hex')
const DEFAULT_CURRENT_HASH = Buffer.from('e858212fd11a41e5', 'hex')
const ANOTHER_CURRENT_HASH = Buffer.from('e851212fd11a21e9', 'hex')

const writer = {
  flush: sinon.stub(),
}
const DataStreamsWriter = sinon.stub().returns(writer)
const {
  CheckpointRegistry,
  StatsPoint,
  Backlog,
  StatsBucket,
  TimeBuckets,
  DataStreamsProcessor,
  getHeadersSize,
  getMessageSize,
  getSizeOrZero,
} = proxyquire('../../src/datastreams/processor', {
  './writer': { DataStreamsWriter },
})

const mockCheckpoint = {
  currentTimestamp: DEFAULT_TIMESTAMP,
  hash: DEFAULT_CURRENT_HASH,
  parentHash: DEFAULT_PARENT_HASH,
  edgeTags: ['service:service-name', 'env:env-name', 'topic:test-topic'],
  edgeLatencyNs: DEFAULT_LATENCY,
  pathwayLatencyNs: DEFAULT_LATENCY,
  payloadSize: 100,
}

const anotherMockCheckpoint = {
  currentTimestamp: DEFAULT_TIMESTAMP,
  hash: ANOTHER_CURRENT_HASH, // todo: different hash
  parentHash: ANOTHER_PARENT_HASH,
  edgeTags: ['service:service-name', 'env:env-name', 'topic:test-topic'],
  edgeLatencyNs: DEFAULT_LATENCY,
  pathwayLatencyNs: DEFAULT_LATENCY,
  payloadSize: 100,
}

describe('StatsPoint', () => {
  it('should add latencies', () => {
    const aggStats = new StatsPoint(mockCheckpoint.hash, mockCheckpoint.parentHash, mockCheckpoint.edgeTags)
    aggStats.addLatencies(mockCheckpoint)
    const edgeLatency = new LogCollapsingLowestDenseDDSketch(HIGH_ACCURACY_DISTRIBUTION)
    const pathwayLatency = new LogCollapsingLowestDenseDDSketch(HIGH_ACCURACY_DISTRIBUTION)
    const payloadSize = new LogCollapsingLowestDenseDDSketch(HIGH_ACCURACY_DISTRIBUTION)
    edgeLatency.accept(DEFAULT_LATENCY / 1e9)
    pathwayLatency.accept(DEFAULT_LATENCY / 1e9)
    payloadSize.accept(100)

    const encoded = aggStats.encode()
    assert.strictEqual(encoded.Hash, DEFAULT_CURRENT_HASH.readBigUInt64LE())
    assert.strictEqual(encoded.ParentHash, DEFAULT_PARENT_HASH.readBigUInt64LE())
    assert.deepStrictEqual(encoded.EdgeTags, aggStats.edgeTags)
    assert.deepStrictEqual(encoded.EdgeLatency, edgeLatency.toProto())
    assert.deepStrictEqual(encoded.PathwayLatency, pathwayLatency.toProto())
    assert.deepStrictEqual(encoded.PayloadSize, payloadSize.toProto())
  })
})

describe('StatsBucket', () => {
  describe('Checkpoints', () => {
    let buckets

    beforeEach(() => { buckets = new StatsBucket() })

    it('should start empty', () => {
      assert.strictEqual(buckets.checkpoints.size, 0)
    })

    it('should add a new entry when no matching key is found', () => {
      const bucket = buckets.forCheckpoint(mockCheckpoint)
      const checkpoints = buckets.checkpoints
      assert.ok(bucket instanceof StatsPoint)
      assert.strictEqual(checkpoints.size, 1)
      const [key, value] = Array.from(checkpoints.entries())[0]
      assert.strictEqual(key.toString(), mockCheckpoint.hash.toString())
      assert.ok(value instanceof StatsPoint)
    })

    it('should not add a new entry if matching key is found', () => {
      buckets.forCheckpoint(mockCheckpoint)
      buckets.forCheckpoint(mockCheckpoint)
      assert.strictEqual(buckets.checkpoints.size, 1)
    })

    it('should add a new entry when new checkpoint does not match existing agg keys', () => {
      buckets.forCheckpoint(mockCheckpoint)
      buckets.forCheckpoint(anotherMockCheckpoint)
      assert.strictEqual(buckets.checkpoints.size, 2)
    })
  })

  describe('Backlogs', () => {
    let backlogBuckets
    const mockBacklog = {
      offset: 12,
      type: 'kafka_consume',
      consumer_group: 'test-consumer',
      partition: 0,
      topic: 'test-topic',
    }

    beforeEach(() => {
      backlogBuckets = new StatsBucket()
    })

    it('should start empty', () => {
      assert.strictEqual(backlogBuckets.backlogs.size, 0)
    })

    it('should add a new entry when empty', () => {
      const bucket = backlogBuckets.forBacklog(mockBacklog)
      const backlogs = backlogBuckets.backlogs
      assert.ok(bucket instanceof Backlog)
      const [, value] = Array.from(backlogs.entries())[0]
      assert.ok(value instanceof Backlog)
    })

    it('should add a new entry when given different tags', () => {
      const otherMockBacklog = {
        offset: 1,
        type: 'kafka_consume',
        consumer_group: 'test-consumer',
        partition: 1,
        topic: 'test-topic',
      }

      backlogBuckets.forBacklog(mockBacklog)
      backlogBuckets.forBacklog(otherMockBacklog)
      assert.strictEqual(backlogBuckets.backlogs.size, 2)
    })

    it('should update the existing entry if offset is higher', () => {
      const higherMockBacklog = {
        offset: 16,
        type: 'kafka_consume',
        consumer_group: 'test-consumer',
        partition: 0,
        topic: 'test-topic',
      }

      backlogBuckets.forBacklog(mockBacklog)
      const backlog = backlogBuckets.forBacklog(higherMockBacklog)
      assert.strictEqual(backlog.offset, higherMockBacklog.offset)
      assert.strictEqual(backlogBuckets.backlogs.size, 1)
    })

    it('should discard the passed backlog if offset is lower', () => {
      const lowerMockBacklog = {
        offset: 2,
        type: 'kafka_consume',
        consumer_group: 'test-consumer',
        partition: 0,
        topic: 'test-topic',
      }

      backlogBuckets.forBacklog(mockBacklog)
      const backlog = backlogBuckets.forBacklog(lowerMockBacklog)
      assert.strictEqual(backlog.offset, mockBacklog.offset)
      assert.strictEqual(backlogBuckets.backlogs.size, 1)
    })
  })
})

describe('TimeBuckets', () => {
  it('should acquire a span agg bucket for the given time', () => {
    const buckets = new TimeBuckets()
    assert.strictEqual(buckets.size, 0)
    const bucket = buckets.forTime(12345)
    assert.strictEqual(buckets.size, 1)
    assert.ok(bucket instanceof StatsBucket)
  })
})

describe('DataStreamsProcessor', () => {
  let edgeLatency
  let pathwayLatency
  let processor
  let payloadSize

  const config = {
    dsmEnabled: true,
    hostname: '127.0.0.1',
    port: 8126,
    url: new URL('http://127.0.0.1:8126'),
    env: 'test',
    version: 'v1',
    service: 'service1',
    tags: { foo: 'foovalue', bar: 'barvalue' },
  }

  beforeEach(() => {
    processor = new DataStreamsProcessor(config)
    clearTimeout(processor.timer)
  })

  it('should construct', () => {
    processor = new DataStreamsProcessor(config)
    clearTimeout(processor.timer)

    sinon.assert.calledWith(DataStreamsWriter, {
      hostname: config.hostname,
      port: config.port,
      url: config.url,
    })
    assert.ok(processor.buckets instanceof TimeBuckets)
    assert.strictEqual(processor.hostname, hostname())
    assert.strictEqual(processor.enabled, config.dsmEnabled)
    assert.strictEqual(processor.env, config.env)
    assert.deepStrictEqual(processor.tags, config.tags)
  })

  it('should track backlogs', () => {
    const mockBacklog = {
      offset: 12,
      type: 'kafka_consume',
      consumer_group: 'test-consumer',
      partition: 0,
      topic: 'test-topic',
    }
    assert.strictEqual(processor.buckets.size, 0)
    processor.recordOffset({ timestamp: DEFAULT_TIMESTAMP, ...mockBacklog })
    assert.strictEqual(processor.buckets.size, 1)

    const timeBucket = processor.buckets.values().next().value
    assert.ok(timeBucket instanceof StatsBucket)
    assert.strictEqual(timeBucket.backlogs.size, 1)

    const backlog = timeBucket.forBacklog(mockBacklog)
    assert.strictEqual(timeBucket.backlogs.size, 1)
    assert.ok(backlog instanceof Backlog)

    const encoded = backlog.encode()
    assert.deepStrictEqual(encoded, {
      Tags: [
        'consumer_group:test-consumer', 'partition:0', 'topic:test-topic', 'type:kafka_consume',
      ],
      Value: 12,
    })
  })

  it('should track latency stats', () => {
    assert.strictEqual(processor.buckets.size, 0)
    processor.recordCheckpoint(mockCheckpoint)
    assert.strictEqual(processor.buckets.size, 1)

    const timeBucket = processor.buckets.values().next().value
    assert.ok(timeBucket instanceof StatsBucket)
    assert.strictEqual(timeBucket.checkpoints.size, 1)

    const checkpointBucket = timeBucket.forCheckpoint(mockCheckpoint)
    assert.strictEqual(timeBucket.checkpoints.size, 1)
    assert.ok(checkpointBucket instanceof StatsPoint)

    edgeLatency = new LogCollapsingLowestDenseDDSketch(0.00775)
    pathwayLatency = new LogCollapsingLowestDenseDDSketch(0.00775)
    payloadSize = new LogCollapsingLowestDenseDDSketch(0.00775)
    edgeLatency.accept(mockCheckpoint.edgeLatencyNs / 1e9)
    pathwayLatency.accept(mockCheckpoint.pathwayLatencyNs / 1e9)
    payloadSize.accept(mockCheckpoint.payloadSize)

    const encoded = checkpointBucket.encode()
    assert.strictEqual(encoded.Hash, DEFAULT_CURRENT_HASH.readBigUInt64LE())
    assert.strictEqual(encoded.ParentHash, DEFAULT_PARENT_HASH.readBigUInt64LE())
    assert.deepStrictEqual(encoded.EdgeTags, mockCheckpoint.edgeTags)
    assert.deepStrictEqual(encoded.EdgeLatency, edgeLatency.toProto())
    assert.deepStrictEqual(encoded.PathwayLatency, pathwayLatency.toProto())
    assert.deepStrictEqual(encoded.PayloadSize, payloadSize.toProto())
  })

  it('should export on interval', () => {
    processor.recordCheckpoint(mockCheckpoint)
    processor.onInterval()
    sinon.assert.calledWith(writer.flush, {
      Env: 'test',
      Service: 'service1',
      Version: 'v1',
      Stats: [{
        Start: 1680000000000n,
        Duration: 10000000000n,
        Stats: [{
          Hash: DEFAULT_CURRENT_HASH.readBigUInt64LE(),
          ParentHash: DEFAULT_PARENT_HASH.readBigUInt64LE(),
          EdgeTags: mockCheckpoint.edgeTags,
          EdgeLatency: edgeLatency.toProto(),
          PathwayLatency: pathwayLatency.toProto(),
          PayloadSize: payloadSize.toProto(),
        }],
        Backlogs: [],
      }],
      TracerVersion: pkg.version,
      Lang: 'javascript',
      Tags: ['foo:foovalue', 'bar:barvalue'],
    })
  })

  it('should include ProcessTags when propagation is enabled', () => {
    const propagationHash = require('../../src/propagation-hash')
    const processTags = require('../../src/process-tags')

    // Configure and enable the feature
    propagationHash.configure({ propagateProcessTags: { enabled: true } })

    processor.recordCheckpoint(mockCheckpoint)
    processor.onInterval()

    const call = writer.flush.getCall(writer.flush.callCount - 1)
    const payload = call.args[0]

    assert.ok(payload.ProcessTags, 'ProcessTags should be present')
    assert.deepStrictEqual(
      payload.ProcessTags,
      processTags.serialized.split(','),
      'ProcessTags should match process-tags module as array'
    )

    // Cleanup
    propagationHash.configure(null)
  })

  it('should not include ProcessTags when propagation is disabled', () => {
    const propagationHash = require('../../src/propagation-hash')

    // Ensure the feature is disabled
    propagationHash.configure({ propagateProcessTags: { enabled: false } })

    processor.recordCheckpoint(mockCheckpoint)
    processor.onInterval()

    const call = writer.flush.getCall(writer.flush.callCount - 1)
    const payload = call.args[0]

    assert.strictEqual(payload.ProcessTags, undefined, 'ProcessTags should not be present')

    // Cleanup
    propagationHash.configure(null)
  })
})

describe('CheckpointRegistry', () => {
  let registry

  beforeEach(() => {
    registry = new CheckpointRegistry()
  })

  it('assigns IDs sequentially starting at 1', () => {
    assert.strictEqual(registry.getId('alpha'), 1)
    assert.strictEqual(registry.getId('beta'), 2)
    assert.strictEqual(registry.getId('gamma'), 3)
  })

  it('returns the same ID for repeated names', () => {
    const first = registry.getId('alpha')
    const second = registry.getId('alpha')
    assert.strictEqual(first, second)
    assert.strictEqual(first, 1)
  })

  it('returns undefined when 254 names are exhausted', () => {
    for (let i = 1; i <= 254; i++) {
      registry.getId(`name-${i}`)
    }
    assert.strictEqual(registry.getId('overflow'), undefined)
  })

  it('encodedKeys returns correct [id][nameLen][name] wire bytes', () => {
    registry.getId('foo')
    registry.getId('bar')
    const encoded = registry.encodedKeys

    // 'foo': [0x01, 0x03, 'f', 'o', 'o']
    // 'bar': [0x02, 0x03, 'b', 'a', 'r']
    assert.strictEqual(encoded.length, 10)
    assert.strictEqual(encoded.readUInt8(0), 1) // id
    assert.strictEqual(encoded.readUInt8(1), 3) // nameLen
    assert.strictEqual(encoded.toString('utf8', 2, 5), 'foo')
    assert.strictEqual(encoded.readUInt8(5), 2) // id
    assert.strictEqual(encoded.readUInt8(6), 3) // nameLen
    assert.strictEqual(encoded.toString('utf8', 7, 10), 'bar')
  })

  it('encodedKeys returns empty Buffer when empty', () => {
    const encoded = registry.encodedKeys
    assert.ok(Buffer.isBuffer(encoded))
    assert.strictEqual(encoded.length, 0)
  })

  it('truncates names longer than 255 bytes in encodedKeys', () => {
    // Build a name that is 260 UTF-8 bytes (all ASCII)
    const longName = 'a'.repeat(260)
    registry.getId(longName)
    const encoded = registry.encodedKeys
    // [id uint8][nameLen uint8][name 255 bytes] = 257 bytes total
    assert.strictEqual(encoded.length, 257)
    assert.strictEqual(encoded.readUInt8(1), 255)
  })
})

describe('DataStreamsProcessor.trackTransaction', () => {
  const config = {
    dsmEnabled: true,
    hostname: '127.0.0.1',
    port: 8126,
    url: new URL('http://127.0.0.1:8126'),
    env: 'test',
    version: 'v1',
    service: 'service1',
    tags: {},
  }

  let processor
  let clock

  beforeEach(() => {
    clock = sinon.useFakeTimers({ now: DEFAULT_TIMESTAMP, toFake: ['Date'] })
    processor = new DataStreamsProcessor(config)
    clearTimeout(processor.timer)
  })

  afterEach(() => {
    clock.restore()
  })

  it('no-ops and warns when processor is disabled', () => {
    const warnStub = sinon.stub()
    const { DataStreamsProcessor: PatchedProcessor } = proxyquire('../../src/datastreams/processor', {
      './writer': { DataStreamsWriter },
      '../log': { warn: warnStub },
    })
    const disabledProcessor = new PatchedProcessor({ ...config, dsmEnabled: false })
    clearTimeout(disabledProcessor.timer)
    disabledProcessor.trackTransaction('tx-001', 'ingested')
    assert.strictEqual(disabledProcessor.buckets.size, 0)
    sinon.assert.calledOnce(warnStub)
  })

  it('adds transaction to the correct time bucket', () => {
    processor.trackTransaction('tx-001', 'ingested')
    assert.strictEqual(processor.buckets.size, 1)
    const bucket = processor.buckets.values().next().value
    assert.ok(bucket._transactions !== null)
  })

  it('encodes correct binary wire format', () => {
    processor.trackTransaction('tx-001', 'ingested')
    const bucket = processor.buckets.values().next().value
    const txBytes = bucket._transactions

    // [checkpointId=1 uint8][timestamp int64 BE 8 bytes][idLen=6 uint8]['tx-001' 6 bytes]
    assert.strictEqual(txBytes.readUInt8(0), 1) // checkpointId

    const timestampNs = BigInt(DEFAULT_TIMESTAMP) * 1_000_000n
    assert.strictEqual(txBytes.readBigInt64BE(1), timestampNs)

    assert.strictEqual(txBytes.readUInt8(9), 6)          // idLen for 'tx-001'
    assert.strictEqual(txBytes.toString('utf8', 10, 16), 'tx-001')
    assert.strictEqual(txBytes.length, 16)
  })

  it('truncates transactionId longer than 255 bytes', () => {
    const longId = 'x'.repeat(300)
    processor.trackTransaction(longId, 'ingested')
    const bucket = processor.buckets.values().next().value
    const txBytes = bucket._transactions
    // [1 byte id][8 byte ts][1 byte len][255 bytes id] = 265 total
    assert.strictEqual(txBytes.length, 265)
    assert.strictEqual(txBytes.readUInt8(9), 255)
  })

  it('silently drops transaction when registry is full', () => {
    // Fill registry with 254 unique names
    for (let i = 1; i <= 254; i++) {
      processor.trackTransaction('tx', `checkpoint-${i}`)
    }
    const bucketsBefore = processor.buckets.size
    // 255th unique checkpoint name — registry is full
    processor.trackTransaction('tx-overflow', 'checkpoint-255')
    // No new bucket created for the dropped transaction
    assert.strictEqual(processor.buckets.size, bucketsBefore)
  })

  it('concatenates multiple transactions within the same bucket', () => {
    processor.trackTransaction('tx-001', 'ingested')
    processor.trackTransaction('tx-002', 'ingested')
    const bucket = processor.buckets.values().next().value
    const txBytes = bucket._transactions
    // Each entry: [1 id][8 ts][1 len][6 id bytes] = 16 bytes → total 32
    assert.strictEqual(txBytes.length, 32)
  })
})

describe('_serializeBuckets with transactions', () => {
  const config = {
    dsmEnabled: true,
    hostname: '127.0.0.1',
    port: 8126,
    url: new URL('http://127.0.0.1:8126'),
    env: 'test',
    version: 'v1',
    service: 'service1',
    tags: {},
  }

  let processor
  let clock

  beforeEach(() => {
    clock = sinon.useFakeTimers({ now: DEFAULT_TIMESTAMP, toFake: ['Date'] })
    processor = new DataStreamsProcessor(config)
    clearTimeout(processor.timer)
  })

  afterEach(() => {
    clock.restore()
  })

  it('includes Transactions and TransactionCheckpointIds when transactions are present', () => {
    processor.trackTransaction('tx-001', 'ingested')
    const { Stats } = processor._serializeBuckets()
    assert.strictEqual(Stats.length, 1)
    assert.ok(Buffer.isBuffer(Stats[0].Transactions))
    assert.ok(Buffer.isBuffer(Stats[0].TransactionCheckpointIds))
    assert.ok(Stats[0].TransactionCheckpointIds.length > 0)
  })

  it('omits Transactions and TransactionCheckpointIds when no transactions in bucket', () => {
    processor.recordCheckpoint(mockCheckpoint)
    const { Stats } = processor._serializeBuckets()
    assert.strictEqual(Stats.length, 1)
    assert.strictEqual(Stats[0].Transactions, undefined)
    assert.strictEqual(Stats[0].TransactionCheckpointIds, undefined)
  })

  it('both buckets share the same TransactionCheckpointIds snapshot when transactions span multiple buckets', () => {
    processor.trackTransaction('tx-001', 'ingested')

    // Advance clock to create a second time bucket
    clock.tick(15000)
    processor.trackTransaction('tx-002', 'processed')

    const { Stats } = processor._serializeBuckets()
    const bucketsWithTx = Stats.filter(b => b.Transactions !== undefined)
    assert.strictEqual(bucketsWithTx.length, 2)

    // Both buckets should have the same checkpoint ID mapping snapshot
    assert.deepStrictEqual(bucketsWithTx[0].TransactionCheckpointIds, bucketsWithTx[1].TransactionCheckpointIds)
  })
})

describe('getSizeOrZero', () => {
  it('should return the size of a string', () => {
    assert.strictEqual(getSizeOrZero('hello'), 5)
  })

  it('should handle unicode characters', () => {
    // emoji is 4 bytes
    assert.strictEqual(getSizeOrZero('hello 😀'), 10)
  })

  it('should return the size of an ArrayBuffer', () => {
    const buffer = new ArrayBuffer(10)
    assert.strictEqual(getSizeOrZero(buffer), 10)
  })

  it('should return the size of a Buffer', () => {
    const buffer = Buffer.from('hello', 'utf-8')
    assert.strictEqual(getSizeOrZero(buffer), 5)
  })
})

describe('getHeadersSize', () => {
  it('should return 0 for undefined/empty headers', () => {
    assert.strictEqual(getHeadersSize(undefined), 0)
    assert.strictEqual(getHeadersSize({}), 0)
  })

  it('should return the total size of all headers', () => {
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': '100',
    }
    assert.strictEqual(getHeadersSize(headers), 45)
  })
})

describe('getMessageSize', () => {
  it('should return the size of a message', () => {
    const message = {
      key: 'key',
      value: 'value',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '100',
      },
    }
    assert.strictEqual(getMessageSize(message), 53)
  })
})
