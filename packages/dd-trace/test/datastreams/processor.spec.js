'use strict'

require('../setup/tap')

const { hostname } = require('os')

const { LogCollapsingLowestDenseDDSketch } = require('@datadog/sketches-js')

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
} = proxyquire('../src/datastreams/processor', {
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
    expect(encoded.Hash).to.equal(DEFAULT_CURRENT_HASH.readBigUInt64LE())
    expect(encoded.ParentHash).to.equal(DEFAULT_PARENT_HASH.readBigUInt64LE())
    expect(encoded.EdgeTags).to.deep.equal(aggStats.edgeTags)
    expect(encoded.EdgeLatency).to.deep.equal(edgeLatency.toProto())
    expect(encoded.PathwayLatency).to.deep.equal(pathwayLatency.toProto())
    expect(encoded.PayloadSize).to.deep.equal(payloadSize.toProto())
  })
})

describe('StatsBucket', () => {
  describe('Checkpoints', () => {
    let buckets

    beforeEach(() => { buckets = new StatsBucket() })

    it('should start empty', () => {
      expect(buckets.checkpoints.size).to.equal(0)
    })

    it('should add a new entry when no matching key is found', () => {
      const bucket = buckets.forCheckpoint(mockCheckpoint)
      const checkpoints = buckets.checkpoints
      expect(bucket).to.be.an.instanceOf(StatsPoint)
      expect(checkpoints.size).to.equal(1)
      const [key, value] = Array.from(checkpoints.entries())[0]
      expect(key.toString()).to.equal(mockCheckpoint.hash.toString())
      expect(value).to.be.instanceOf(StatsPoint)
    })

    it('should not add a new entry if matching key is found', () => {
      buckets.forCheckpoint(mockCheckpoint)
      buckets.forCheckpoint(mockCheckpoint)
      expect(buckets.checkpoints.size).to.equal(1)
    })

    it('should add a new entry when new checkpoint does not match existing agg keys', () => {
      buckets.forCheckpoint(mockCheckpoint)
      buckets.forCheckpoint(anotherMockCheckpoint)
      expect(buckets.checkpoints.size).to.equal(2)
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
      expect(backlogBuckets.backlogs.size).to.equal(0)
    })

    it('should add a new entry when empty', () => {
      const bucket = backlogBuckets.forBacklog(mockBacklog)
      const backlogs = backlogBuckets.backlogs
      expect(bucket).to.be.an.instanceOf(Backlog)
      const [, value] = Array.from(backlogs.entries())[0]
      expect(value).to.be.instanceOf(Backlog)
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
      expect(backlogBuckets.backlogs.size).to.equal(2)
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
      expect(backlog.offset).to.equal(higherMockBacklog.offset)
      expect(backlogBuckets.backlogs.size).to.equal(1)
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
      expect(backlog.offset).to.equal(mockBacklog.offset)
      expect(backlogBuckets.backlogs.size).to.equal(1)
    })
  })
})

describe('TimeBuckets', () => {
  it('should acquire a span agg bucket for the given time', () => {
    const buckets = new TimeBuckets()
    expect(buckets.size).to.equal(0)
    const bucket = buckets.forTime(12345)
    expect(buckets.size).to.equal(1)
    expect(bucket).to.be.an.instanceOf(StatsBucket)
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

    expect(DataStreamsWriter).to.be.calledWith({
      hostname: config.hostname,
      port: config.port,
      url: config.url
    })
    expect(processor.buckets).to.be.instanceOf(TimeBuckets)
    expect(processor.hostname).to.equal(hostname())
    expect(processor.enabled).to.equal(config.dsmEnabled)
    expect(processor.env).to.equal(config.env)
    expect(processor.tags).to.deep.equal(config.tags)
  })

  it('should track backlogs', () => {
    const mockBacklog = {
      offset: 12,
      type: 'kafka_consume',
      consumer_group: 'test-consumer',
      partition: 0,
      topic: 'test-topic'
    }
    expect(processor.buckets.size).to.equal(0)
    processor.recordOffset({ timestamp: DEFAULT_TIMESTAMP, ...mockBacklog })
    expect(processor.buckets.size).to.equal(1)

    const timeBucket = processor.buckets.values().next().value
    expect(timeBucket).to.be.instanceOf(StatsBucket)
    expect(timeBucket.backlogs.size).to.equal(1)

    const backlog = timeBucket.forBacklog(mockBacklog)
    expect(timeBucket.backlogs.size).to.equal(1)
    expect(backlog).to.be.instanceOf(Backlog)

    const encoded = backlog.encode()
    expect(encoded).to.deep.equal({
      Tags: [
        'consumer_group:test-consumer', 'partition:0', 'topic:test-topic', 'type:kafka_consume'
      ],
      Value: 12
    })
  })

  it('should track latency stats', () => {
    expect(processor.buckets.size).to.equal(0)
    processor.recordCheckpoint(mockCheckpoint)
    expect(processor.buckets.size).to.equal(1)

    const timeBucket = processor.buckets.values().next().value
    expect(timeBucket).to.be.instanceOf(StatsBucket)
    expect(timeBucket.checkpoints.size).to.equal(1)

    const checkpointBucket = timeBucket.forCheckpoint(mockCheckpoint)
    expect(timeBucket.checkpoints.size).to.equal(1)
    expect(checkpointBucket).to.be.instanceOf(StatsPoint)

    edgeLatency = new LogCollapsingLowestDenseDDSketch(0.00775)
    pathwayLatency = new LogCollapsingLowestDenseDDSketch(0.00775)
    payloadSize = new LogCollapsingLowestDenseDDSketch(0.00775)
    edgeLatency.accept(mockCheckpoint.edgeLatencyNs / 1e9)
    pathwayLatency.accept(mockCheckpoint.pathwayLatencyNs / 1e9)
    payloadSize.accept(mockCheckpoint.payloadSize)

    const encoded = checkpointBucket.encode()
    expect(encoded.Hash).to.equal(DEFAULT_CURRENT_HASH.readBigUInt64LE())
    expect(encoded.ParentHash).to.equal(DEFAULT_PARENT_HASH.readBigUInt64LE())
    expect(encoded.EdgeTags).to.deep.equal(mockCheckpoint.edgeTags)
    expect(encoded.EdgeLatency).to.deep.equal(edgeLatency.toProto())
    expect(encoded.PathwayLatency).to.deep.equal(pathwayLatency.toProto())
    expect(encoded.PayloadSize).to.deep.equal(payloadSize.toProto())
  })

  it('should export on interval', () => {
    processor.recordCheckpoint(mockCheckpoint)
    processor.onInterval()
    expect(writer.flush).to.be.calledWith({
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
    expect(getSizeOrZero('hello')).to.equal(5)
  })

  it('should handle unicode characters', () => {
    // emoji is 4 bytes
    expect(getSizeOrZero('hello 😀')).to.equal(10)
  })

  it('should return the size of an ArrayBuffer', () => {
    const buffer = new ArrayBuffer(10)
    expect(getSizeOrZero(buffer)).to.equal(10)
  })

  it('should return the size of a Buffer', () => {
    const buffer = Buffer.from('hello', 'utf-8')
    expect(getSizeOrZero(buffer)).to.equal(5)
  })
})

describe('getHeadersSize', () => {
  it('should return 0 for undefined/empty headers', () => {
    expect(getHeadersSize(undefined)).to.equal(0)
    expect(getHeadersSize({})).to.equal(0)
  })

  it('should return the total size of all headers', () => {
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': '100'
    }
    expect(getHeadersSize(headers)).to.equal(45)
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
    expect(getMessageSize(message)).to.equal(53)
  })
})
