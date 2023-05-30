const os = require('os')
const pkg = require('../../../../package.json')
const Uint64 = require('int64-buffer').Uint64BE

const { LogCollapsingLowestDenseDDSketch } = require('@datadog/sketches-js')

const { DataStreamsWriter } = require('./writer')

const HIGH_ACCURACY_DISTRIBUTION = 0.0075

class StatsPoint {
  constructor (hash, parentHash, edgeTags) {
    console.log("hash is ", hash)
    console.log("parent hash is ", parentHash)
    this.hash = new Uint64(hash)
    this.parentHash = new Uint64(parentHash)
    this.edgeTags = edgeTags
    this.edgeLatency = new LogCollapsingLowestDenseDDSketch(HIGH_ACCURACY_DISTRIBUTION)
    this.pathwayLatency = new LogCollapsingLowestDenseDDSketch(HIGH_ACCURACY_DISTRIBUTION)
  }

  addLatencies (checkpoint) {
    const edgeLatencySec = checkpoint.edgeLatencyNs / 1e9
    const pathwayLatencySec = checkpoint.pathwayLatencyNs / 1e9
    this.edgeLatency.accept(edgeLatencySec)
    this.pathwayLatency.accept(pathwayLatencySec)
  }

  encode () {
    return {
      Hash: this.hash,
      ParentHash: this.parentHash,
      EdgeTags: this.edgeTags,
      EdgeLatency: this.edgeLatency.toProto(),
      PathwayLatency: this.pathwayLatency.toProto()
    }
  }
}

class StatsBucket extends Map {
  forCheckpoint (checkpoint) {
    const key = checkpoint.hash
    // also include parentHash, edgeTags in ddsketch
    if (!this.has(key)) {
      this.set(key, new StatsPoint(aggKey)) // StatsPoint
    }

    return this.get(key)
  }
}

class TimeBuckets extends Map {
  forTime (time) {
    if (!this.has(time)) {
      this.set(time, new StatsBucket())
    }

    return this.get(time)
  }
}

class DataStreamsProcessor {
  constructor ({
    dsmEnabled,
    hostname,
    port,
    url,
    env,
    tags
  } = {}) {
    this.writer = new DataStreamsWriter({
      hostname,
      port,
      url
    })
    this.bucketSizeNs = 1e10
    this.buckets = new TimeBuckets()
    this.hostname = os.hostname()
    this.enabled = dsmEnabled
    this.env = env
    this.tags = tags || {}
    this.service = this.tags.service || 'unnamed-nodejs-service'
    console.log('TAG', this.tags)
    this.sequence = 0

    if (this.enabled) {
      this.timer = setInterval(this.onInterval.bind(this), 10000) // TODO[piochelepiotr] Update to 10s
      this.timer.unref()
    }
  }

  onInterval () {
    console.log('serializing buckets')
    const serialized = this._serializeBuckets()
    if (!serialized) return
    const payload = {
      Env: this.env,
      Service: this.service,
      Stats: serialized,
      TracerVersion: pkg.version,
      Lang: 'javascript'
    }
    this.writer.flush(payload)
  }

  recordCheckpoint (checkpoint) {
    if (!this.enabled) return
    console.log('setting checkpoint', checkpoint)

    const bucketTime = Math.round(checkpoint.currentTimestamp - (checkpoint.currentTimestamp % this.bucketSizeNs))
    console.log('bucketTime', bucketTime)

    this.buckets.forTime(bucketTime)
      .forCheckpoint(checkpoint)
      .addLatencies(checkpoint)
  }

  _serializeBuckets () {
    const serializedBuckets = []

    for (const [ timeNs, bucket ] of this.buckets.entries()) {
      const points = []

      for (const stats of bucket.values()) {
        points.push(stats.encode())
      }

      serializedBuckets.push({
        Start: new Uint64(timeNs),
        Duration: new Uint64(this.bucketSizeNs),
        Stats: points
      })
    }

    this.buckets.clear()

    return serializedBuckets
  }
}

module.exports = {
  LatencyStatsProcessor: DataStreamsProcessor,
  AggKey,
  AggStats: StatsPoint,
  SpanBuckets: StatsBucket,
  TimeBuckets
}
