'use strict'

require('./setup/tap')
const util = require('util')

const { hostname } = require('os')

const { LogCollapsingLowestDenseDDSketch } = require('@datadog/sketches-js')

const { decodePathwayContext } = require('../../datadog-plugin-kafkajs/src/hash')

const { version } = require('../src/pkg')
const pkg = require('../../../package.json')
const DEFAULT_TIMESTAMP = 1
const DEFAULT_LATENCY = 100
const DEFAULT_PATHWAY_CTX = Buffer.from('e073ca23a5577149a0a8879de561a0a8879de561', 'hex')
const DEFAULT_PARENT_HASH = Buffer.from('e858292fd15a41e4', 'hex')
const ANOTHER_PARENT_HASH = Buffer.from('e858292fd15a4100', 'hex')
const DEFAULT_CURRENT_HASH = decodePathwayContext(DEFAULT_PATHWAY_CTX)[0]

const mockCheckpoint = {
  currentTimestamp: DEFAULT_TIMESTAMP,
  metrics: {
    'parent_hash': DEFAULT_PARENT_HASH,
    'edge_tags': { 'service': 'service-name', 'env': 'env-name', 'topic': 'test-topic' },
    'dd-pathway-ctx': DEFAULT_PATHWAY_CTX,
    'edge_latency': DEFAULT_LATENCY,
    'pathway_latency': DEFAULT_LATENCY
  }
}

const anotherMockCheckpoint = {
  currentTimestamp: DEFAULT_TIMESTAMP,
  metrics: {
    'parent_hash': ANOTHER_PARENT_HASH,
    'edge_tags': { 'service': 'service-name', 'env': 'env-name', 'topic': 'test-topic' },
    'dd-pathway-ctx': DEFAULT_PATHWAY_CTX,
    'edge_latency': DEFAULT_LATENCY,
    'pathway_latency': DEFAULT_LATENCY
  }
}

const exporter = {
  export: sinon.stub()
}

const LatencyStatsExporter = sinon.stub().returns(exporter)

const {
  AggStats,
  AggKey,
  SpanBuckets,
  TimeBuckets,
  LatencyStatsProcessor
} = proxyquire('../src/latency_stats', {
  './exporters/latency-stats': {
    LatencyStatsExporter
  }
})

describe('AggKey', () => {
  it('should make aggregation key for a checkpoint', () => {
    const key = new AggKey(mockCheckpoint)
    expect(key.toString()).to.equal(`${DEFAULT_CURRENT_HASH.toString()},${DEFAULT_PARENT_HASH.toString()}`)
  })
})

describe('AggStats', () => {
  it('should record a checkpoint', () => {
    const aggKey = new AggKey(mockCheckpoint)
    const aggStats = new AggStats(aggKey)
    aggStats.record(mockCheckpoint)

    const edgeLatency = new LogCollapsingLowestDenseDDSketch(0.00775)
    const pathwayLatency = new LogCollapsingLowestDenseDDSketch(0.00775)
    edgeLatency.accept(DEFAULT_LATENCY)
    pathwayLatency.accept(DEFAULT_LATENCY)

    const aggStatsJSON = aggStats.toJSON()

    expect(aggStatsJSON.Hash.length).to.equal(DEFAULT_CURRENT_HASH.length)
    for (let i = 0; i < DEFAULT_CURRENT_HASH.length; i++) {
      expect(aggStatsJSON.Hash[i]).to.equal(DEFAULT_CURRENT_HASH[i])
    }
    expect(aggStatsJSON.ParentHash.length).to.equal(DEFAULT_PARENT_HASH.length)
    for (let i = 0; i < DEFAULT_PARENT_HASH.length; i++) {
      expect(aggStatsJSON.ParentHash[i]).to.equal(DEFAULT_PARENT_HASH[i])
    }
    expect(aggStatsJSON.EdgeTags).to.deep.equal(aggKey.edgeTags)
    expect(aggStatsJSON.EdgeLatency).to.deep.equal(edgeLatency.toProto())
    expect(aggStatsJSON.PathwayLatency).to.deep.equal(pathwayLatency.toProto())
  })
})

describe('SpanBuckets', () => {
  const buckets = new SpanBuckets()

  it('should start empty', () => {
    expect(buckets.size).to.equal(0)
  })

  it('should add a new entry when no matching agg key is found', () => {
    const bucket = buckets.forCheckpoint(mockCheckpoint)
    expect(bucket).to.be.an.instanceOf(AggStats)
    expect(buckets.size).to.equal(1)
    const [key, value] = Array.from(buckets.entries())[0]
    expect(key).to.equal((new AggKey(mockCheckpoint)).toString())
    expect(value).to.be.instanceOf(AggStats)
  })

  it('should not add a new entry if matching agg key is found', () => {
    buckets.forCheckpoint(mockCheckpoint)
    expect(buckets.size).to.equal(1)
  })

  it('should add a new entry when new checkpoint does not match existing agg keys', () => {
    buckets.forCheckpoint(anotherMockCheckpoint)
    expect(buckets.size).to.equal(2)
  })
})

describe('TimeBuckets', () => {
  it('should acquire a span agg bucket for the given time', () => {
    const buckets = new TimeBuckets()
    expect(buckets.size).to.equal(0)
    const bucket = buckets.forTime(12345)
    expect(buckets.size).to.equal(1)
    expect(bucket).to.be.an.instanceOf(SpanBuckets)
  })
})

describe('LatencyStatsProcessor', () => {
  let edgeLatency
  let pathwayLatency
  let processor
  let checkpoint

  const config = {
    dsmEnabled: true,
    hostname: '127.0.0.1',
    port: 8126,
    url: new URL('http://127.0.0.1:8126'),
    env: 'test',
    tags: { tag: 'some tag' }
  }

  it('should construct', () => {
    processor = new LatencyStatsProcessor(config)
    clearTimeout(processor.timer)

    expect(LatencyStatsExporter).to.be.calledWith({
      hostname: config.hostname,
      port: config.port,
      url: config.url,
      tags: config.tags
    })
    expect(processor.buckets).to.be.instanceOf(TimeBuckets)
    expect(processor.hostname).to.equal(hostname())
    expect(processor.enabled).to.equal(config.dsmEnabled)
    expect(processor.env).to.equal(config.env)
    expect(processor.tags).to.deep.equal(config.tags)
  })

  it('should track latency stats', () => {
    expect(processor.buckets.size).to.equal(0)
    processor.recordCheckpoint(mockCheckpoint)
    expect(processor.buckets.size).to.equal(1)

    const timeBucket = processor.buckets.values().next().value
    expect(timeBucket).to.be.instanceOf(SpanBuckets)
    expect(timeBucket.size).to.equal(1)

    const checkpointBucket = timeBucket.forCheckpoint(mockCheckpoint)
    expect(timeBucket.size).to.equal(1)
    expect(checkpointBucket).to.be.instanceOf(AggStats)

    edgeLatency = new LogCollapsingLowestDenseDDSketch(0.00775)
    pathwayLatency = new LogCollapsingLowestDenseDDSketch(0.00775)
    edgeLatency.accept(mockCheckpoint.metrics.edge_latency)
    pathwayLatency.accept(mockCheckpoint.metrics.pathway_latency)

    checkpoint = checkpointBucket.toJSON()

    expect(checkpoint.Hash.length).to.equal(DEFAULT_CURRENT_HASH.length)
    for (let i = 0; i < DEFAULT_CURRENT_HASH.length; i++) {
      expect(checkpoint.Hash[i]).to.equal(DEFAULT_CURRENT_HASH[i])
    }
    expect(checkpoint.ParentHash.length).to.equal(DEFAULT_PARENT_HASH.length)
    for (let i = 0; i < DEFAULT_PARENT_HASH.length; i++) {
      expect(checkpoint.ParentHash[i]).to.equal(DEFAULT_PARENT_HASH[i])
    }
    expect(checkpoint.EdgeTags).to.deep.equal(mockCheckpoint.metrics.edge_tags)
    expect(checkpoint.EdgeLatency).to.deep.equal(edgeLatency.toProto())
    expect(checkpoint.PathwayLatency).to.deep.equal(pathwayLatency.toProto())
  })

  it('should export on interval', () => {
    processor.onInterval()
    expect(exporter.export).to.be.calledWith({
      Env: 'test',
      Service: undefined,
      PrimaryTag: { tag: 'some tag' },
      Stats: [{
        Start: 0,
        Duration: 10000000000,
        Stats: [{
          Hash: checkpoint.Hash,
          ParentHash: checkpoint.ParentHash,
          EdgeTags: mockCheckpoint.metrics.edge_tags,
          EdgeLatency: edgeLatency.toProto(),
          PathwayLatency: pathwayLatency.toProto()
        }]
      }],
      TracerVersion: pkg.version,
      Lang: 'javascript'
    })
  })
})
