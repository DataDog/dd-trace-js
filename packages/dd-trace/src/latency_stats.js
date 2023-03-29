const os = require('os')
const pkg = require('../../../package.json')

const { LogCollapsingLowestDenseDDSketch } = require('@datadog/sketches-js')

const { DSMStatsExporter } = require('./exporters/dsm-stats')

class HeaderAggStats {
  constructor (hash) {
    this.hash = hash
    this.edgeLatency = new LogCollapsingLowestDenseDDSketch(0.00775)
    this.pathwayLatency = new LogCollapsingLowestDenseDDSketch(0.00775)
  }

  record (header) {
    // TODO
    const edgeLatency = header.metrics.edgeLatency
    const pathwayLatency = header.metrics.pathwayLatency
    this.edgeLatency.accept(edgeLatency)
    this.pathwayLatency.accept(pathwayLatency)
  }

  toJSON () {
    return {
      Hash: this.hash,
      EdgeLatency: this.edgeLatency.toProto(), // TODO: custom proto encoding
      PathwayLatency: this.pathwayLatency.toProto() // TODO: custom proto encoding
    }
  }
}

class HeaderAggKey {
  constructor (header) {
    this.hash = header.metrics.pathwayHash
  }

  toString () {
    return this.hash
  }
}

class SpanBuckets extends Map {
  forHeader (header) {
    const aggKey = new HeaderAggKey(header)
    const key = aggKey.toString()

    if (!this.has(key)) {
      this.set(key, new HeaderAggStats(aggKey))
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
    this.exporter = new DSMStatsExporter({
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

  onFinished (header) {
    if (!this.enabled) return

    const bucketTime = header.currentTs - (header.currentTs % this.bucketSizeNs) // TODO: change currentTs?

    this.buckets.forTime(bucketTime)
      .forHeader(header)
      .record(header)
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

module.exports = { LatencyStatsProcessor, HeaderAggStats }
