'use strict'

require('../setup/tap')

const { hostname } = require('os')
const Uint64 = require('int64-buffer').Uint64LE

const { LogCollapsingLowestDenseDDSketch } = require('@datadog/sketches-js')

const HIGH_ACCURACY_DISTRIBUTION = 0.0075

const pkg = require('../../../../package.json')
const { StatsPoint, StatsBucket, TimeBuckets, DataStreamsProcessor } = require('../../src/datastreams/processor')
const DEFAULT_TIMESTAMP = Number(new Date('2023-04-20T16:20:00.000Z'))
const DEFAULT_LATENCY = 100000000
const DEFAULT_PARENT_HASH = Buffer.from('e858292fd15a41e4', 'hex')
const ANOTHER_PARENT_HASH = Buffer.from('e858292fd15a4100', 'hex')
const DEFAULT_CURRENT_HASH = Buffer.from('e858212fd11a41e5', 'hex')
const ANOTHER_CURRENT_HASH = Buffer.from('e851212fd11a21e9', 'hex')

const writer = {
  flush: sinon.stub()
}

const mockCheckpoint = {
  currentTimestamp: DEFAULT_TIMESTAMP,
  hash: DEFAULT_CURRENT_HASH,
  parentHash: DEFAULT_PARENT_HASH,
  edgeTags: ['service:service-name', 'env:env-name', 'topic:test-topic'],
  edgeLatencyNs: DEFAULT_LATENCY,
  pathwayLatencyNs: DEFAULT_LATENCY
}

const anotherMockCheckpoint = {
  currentTimestamp: DEFAULT_TIMESTAMP,
  hash: ANOTHER_CURRENT_HASH, // todo: different hash
  parentHash: ANOTHER_PARENT_HASH,
  edgeTags: ['service:service-name', 'env:env-name', 'topic:test-topic'],
  edgeLatencyNs: DEFAULT_LATENCY,
  pathwayLatencyNs: DEFAULT_LATENCY
}

describe('StatsPoint', () => {
  it('should add latencies', () => {
    const aggStats = new StatsPoint(mockCheckpoint.hash, mockCheckpoint.parentHash, mockCheckpoint.edgeTags)
    aggStats.addLatencies(mockCheckpoint)
    const edgeLatency = new LogCollapsingLowestDenseDDSketch(HIGH_ACCURACY_DISTRIBUTION)
    const pathwayLatency = new LogCollapsingLowestDenseDDSketch(HIGH_ACCURACY_DISTRIBUTION)
    edgeLatency.accept(DEFAULT_LATENCY/1e9)
    pathwayLatency.accept(DEFAULT_LATENCY/1e9)

    const encoded = aggStats.encode()
    expect(encoded.Hash.toString()).to.equal(new Uint64(DEFAULT_CURRENT_HASH).toString())
    expect(encoded.ParentHash.toString()).to.equal(new Uint64(DEFAULT_PARENT_HASH).toString())
    expect(encoded.EdgeTags).to.deep.equal(aggStats.edgeTags)
    expect(encoded.EdgeLatency).to.deep.equal(edgeLatency.toProto())
    expect(encoded.PathwayLatency).to.deep.equal(pathwayLatency.toProto())
  })
})

describe('StatsBucket', () => {
  const buckets = new StatsBucket()

  it('should start empty', () => {
    expect(buckets.size).to.equal(0)
  })

  it('should add a new entry when no matching key is found', () => {
    const bucket = buckets.forCheckpoint(mockCheckpoint)
    expect(bucket).to.be.an.instanceOf(StatsPoint)
    expect(buckets.size).to.equal(1)
    const [key, value] = Array.from(buckets.entries())[0]
    expect(key.toString()).to.equal(mockCheckpoint.hash.toString())
    expect(value).to.be.instanceOf(StatsPoint)
  })

  it('should not add a new entry if matching key is found', () => {
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
    expect(bucket).to.be.an.instanceOf(StatsBucket)
  })
})

describe('DataStreamsProcessor', () => {
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
    processor = new DataStreamsProcessor(config)
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
        Start: 1680000000000,
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
