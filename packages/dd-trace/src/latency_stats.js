const os = require('os')
const pkg = require('../../../package.json')
const { decodePathwayContext } = require('../../datadog-plugin-kafkajs/src/hash')

const { LogCollapsingLowestDenseDDSketch } = require('@datadog/sketches-js')

const { LatencyStatsExporter } = require('./exporters/latency-stats')

class AggStats {
  constructor (aggKey) {
    this.hash = aggKey.hash
    this.parentHash = aggKey.parentHash
    this.edgeTags = aggKey.edgeTags
    this.edgeLatency = new LogCollapsingLowestDenseDDSketch(0.00775)
    this.pathwayLatency = new LogCollapsingLowestDenseDDSketch(0.00775)
  }

  record (checkpoint) {
    const edgeLatency = checkpoint.metrics.edge_latency
    const pathwayLatency = checkpoint.metrics.pathway_latency
    this.edgeLatency.accept(edgeLatency)
    this.pathwayLatency.accept(pathwayLatency)
  }

  toJSON () {
    return {
      Hash: this.hash,
      ParentHash: this.parentHash,
      EdgeTags: this.edgeTags,
      EdgeLatency: this.edgeLatency.toProto(), // TODO: custom proto encoding
      PathwayLatency: this.pathwayLatency.toProto() // TODO: custom proto encoding
    }
  }
}

class AggKey {
  constructor (checkpoint) {
    this.hash = decodePathwayContext(checkpoint.metrics['dd-pathway-ctx'])[0]
    this.parentHash = checkpoint.metrics.parent_hash
    this.edgeTags = checkpoint.metrics.edge_tags
  }

  toString () {
    return [
      this.hash.toString(),
      this.parentHash.toString()
    ].join(',')
  }
}

class SpanBuckets extends Map {
  forCheckpoint (checkpoint) {
    const aggKey = new AggKey(checkpoint)
    const key = aggKey.toString()
    // also include parentHash, edgeTags in ddsketch
    if (!this.has(key)) {
      this.set(key, new AggStats(aggKey)) // StatsPoint
    }

    return this.get(key)
  }
}

class TimeBuckets extends Map {
  forTime (time) {
    if (!this.has(time)) {
      this.set(time, new SpanBuckets())
    }

    return this.get(time)
  }
}

class LatencyStatsProcessor {
  constructor ({
    dsmEnabled,
    hostname,
    port,
    url,
    env,
    tags
  } = {}) {
    this.exporter = new LatencyStatsExporter({
      hostname,
      port,
      tags,
      url
    })
    this.bucketSizeNs = 1e10
    this.buckets = new TimeBuckets()
    this.hostname = os.hostname()
    this.enabled = dsmEnabled
    this.env = env
    this.tags = tags || {}
    this.sequence = 0

    if (this.enabled) {
      this.timer = setInterval(this.onInterval.bind(this), 1e4) // TODO: the right interval?
      this.timer.unref()
    }
  }

  onInterval () {
    const serialized = this._serializeBuckets()
    if (!serialized) return

    this.exporter.export({
      Env: this.env,
      Service: this.service, // exists?
      PrimaryTag: this.tags,
      Stats: serialized,
      TracerVersion: pkg.version,
      Lang: 'javascript'
    })
  }

  recordCheckpoint (checkpoint) {
    if (!this.enabled) return

    const bucketTime = checkpoint.currentTimestamp - (checkpoint.currentTimestamp % this.bucketSizeNs)

    this.buckets.forTime(bucketTime)
      .forCheckpoint(checkpoint)
      .record(checkpoint)
  }

  _serializeBuckets () {
    const serializedBuckets = []

    for (const [ timeNs, bucket ] of this.buckets.entries()) {
      const bucketAggStats = []

      for (const stats of bucket.values()) {
        bucketAggStats.push(stats.toJSON())
      }

      serializedBuckets.push({
        Start: timeNs,
        Duration: this.bucketSizeNs,
        Stats: bucketAggStats
      })
    }

    this.buckets.clear()

    return serializedBuckets
  }
}

module.exports = {
  LatencyStatsProcessor,
  AggKey,
  AggStats,
  SpanBuckets,
  TimeBuckets
}
