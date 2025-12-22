'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('tap').mocha
const sinon = require('sinon')
const { hostname } = require('node:os')
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
  flush: sinon.stub()
}
const DataStreamsWriter = sinon.stub().returns(writer)
const {
  StatsPoint,
  Backlog,
  StatsBucket,
  TimeBuckets,
  DataStreamsProcessor,
  getHeadersSize,
  getMessageSize,
  getSizeOrZero
} = proxyquire('../../src/datastreams/processor', {
  './writer': { DataStreamsWriter }
})

const mockCheckpoint = {
  currentTimestamp: DEFAULT_TIMESTAMP,
  hash: DEFAULT_CURRENT_HASH,
  parentHash: DEFAULT_PARENT_HASH,
  edgeTags: ['service:service-name', 'env:env-name', 'topic:test-topic'],
  edgeLatencyNs: DEFAULT_LATENCY,
  pathwayLatencyNs: DEFAULT_LATENCY,
  payloadSize: 100
}

const anotherMockCheckpoint = {
  currentTimestamp: DEFAULT_TIMESTAMP,
  hash: ANOTHER_CURRENT_HASH, // todo: different hash
  parentHash: ANOTHER_PARENT_HASH,
  edgeTags: ['service:service-name', 'env:env-name', 'topic:test-topic'],
  edgeLatencyNs: DEFAULT_LATENCY,
  pathwayLatencyNs: DEFAULT_LATENCY,
  payloadSize: 100
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
      topic: 'test-topic'
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
        topic: 'test-topic'
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
        topic: 'test-topic'
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
        topic: 'test-topic'
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
    tags: { foo: 'foovalue', bar: 'barvalue' }
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
      url: config.url
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
      topic: 'test-topic'
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
        'consumer_group:test-consumer', 'partition:0', 'topic:test-topic', 'type:kafka_consume'
      ],
      Value: 12
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
          PayloadSize: payloadSize.toProto()
        }],
        Backlogs: []
      }],
      TracerVersion: pkg.version,
      Lang: 'javascript',
      Tags: ['foo:foovalue', 'bar:barvalue']
    })
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
      'Content-Length': '100'
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
        'Content-Length': '100'
      }
    }
    assert.strictEqual(getMessageSize(message), 53)
  })
})
