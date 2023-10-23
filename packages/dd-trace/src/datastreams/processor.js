const os = require('os')
const pkg = require('../../../../package.json')
// Message pack int encoding is done in big endian, but data streams uses little endian
const Uint64 = require('int64-buffer').Uint64BE

const { LogCollapsingLowestDenseDDSketch } = require('@datadog/sketches-js')

const { DataStreamsWriter } = require('./writer')
const { computePathwayHash } = require('./pathway')
const ENTRY_PARENT_HASH = Buffer.from('0000000000000000', 'hex')

const HIGH_ACCURACY_DISTRIBUTION = 0.0075

class StatsPoint {
  constructor (hash, parentHash, edgeTags) {
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

class Backlog {
  constructor ({ offset, ...tags }) {
    this._sortedTags = Object.keys(tags).sort().map(key => `${key}:${tags[key]}`)
    this._offset = offset
    this._timestamp = Date.now() * 1e6
  }

  get offset () { return this._offset }

  get tags () { return this._tags }

  get timestamp () { return this._timestamp }

  get sortedTags () {
    return this._sortedTags
  }
}

class StatsBucket {
  constructor () {
    this._checkpoints = new Map()
    this._backlogs = new Map()
  }

  forCheckpoint (checkpoint) {
    const key = checkpoint.hash
    if (!this._checkpoints.has(key)) {
      this._checkpoints.set(
        key, new StatsPoint(checkpoint.hash, checkpoint.parentHash, checkpoint.edgeTags)
      )
    }

    return this._checkpoints.get(key)
  }

  addBacklog (backlog) {
    /**
     * Conditionally add a backlog to the bucket. If there is currently an offset
     * matching the backlog's tags, overwrite the offset IFF the backlog's offset
     * is greater than the recorded offset.
     *
     * @param backlog: Backlog
     */
    const key = backlog.sortedTags
    const existingOffset = this._backlogs.get(key)
    if (existingOffset !== undefined) {
      if (backlog.offset < existingOffset) {
        return existingOffset
      }
    }
    this._backlogs.set(key, backlog.offset)
    return backlog
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
    tags,
    version,
    service
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
    this.service = service || 'unnamed-nodejs-service'
    this.version = version || ''
    this.sequence = 0

    if (this.enabled) {
      this.timer = setInterval(this.onInterval.bind(this), 10000)
      this.timer.unref()
    }
  }

  onInterval () {
    const { Stats, Backlogs } = this._serializeBuckets()
    if ([ Stats, Backlogs ].every(arr => arr.length === 0)) return
    const payload = {
      Env: this.env,
      Service: this.service,
      Stats,
      Backlogs,
      TracerVersion: pkg.version,
      Version: this.version,
      Lang: 'javascript'
    }
    this.writer.flush(payload)
  }

  recordCheckpoint (checkpoint) {
    if (!this.enabled) return
    const bucketTime = Math.round(checkpoint.currentTimestamp - (checkpoint.currentTimestamp % this.bucketSizeNs))
    this.buckets.forTime(bucketTime)
      .forCheckpoint(checkpoint)
      .addLatencies(checkpoint)
  }

  setCheckpoint (edgeTags, ctx = null) {
    if (!this.enabled) return null
    const nowNs = Date.now() * 1e6
    const direction = edgeTags.find(t => t.startsWith('direction:'))
    let pathwayStartNs = nowNs
    let edgeStartNs = nowNs
    let parentHash = ENTRY_PARENT_HASH
    let closestOppositeDirectionHash = ENTRY_PARENT_HASH
    let closestOppositeDirectionEdgeStart = nowNs
    if (ctx != null) {
      pathwayStartNs = ctx.pathwayStartNs
      edgeStartNs = ctx.edgeStartNs
      parentHash = ctx.hash
      closestOppositeDirectionHash = ctx.closestOppositeDirectionHash || ENTRY_PARENT_HASH
      closestOppositeDirectionEdgeStart = ctx.closestOppositeDirectionEdgeStart || nowNs
      if (direction === ctx.previousDirection) {
        parentHash = ctx.closestOppositeDirectionHash
        if (parentHash === ENTRY_PARENT_HASH) {
          // if the closest hash from opposite direction is the entry hash, that means
          // we produce in a loop, without consuming
          // in that case, we don't want the pathway to be longer and longer, but we want to restart a new pathway.
          edgeStartNs = nowNs
          pathwayStartNs = nowNs
        } else {
          edgeStartNs = ctx.closestOppositeDirectionEdgeStart
        }
      } else {
        closestOppositeDirectionHash = parentHash
        closestOppositeDirectionEdgeStart = edgeStartNs
      }
    }
    const hash = computePathwayHash(this.service, this.env, edgeTags, parentHash)
    const edgeLatencyNs = nowNs - edgeStartNs
    const pathwayLatencyNs = nowNs - pathwayStartNs
    const checkpoint = {
      currentTimestamp: nowNs,
      parentHash: parentHash,
      hash: hash,
      edgeTags: edgeTags,
      edgeLatencyNs: edgeLatencyNs,
      pathwayLatencyNs: pathwayLatencyNs
    }
    this.recordCheckpoint(checkpoint)
    return {
      hash: hash,
      edgeStartNs: edgeStartNs,
      pathwayStartNs: pathwayStartNs,
      previousDirection: direction,
      closestOppositeDirectionHash: closestOppositeDirectionHash,
      closestOppositeDirectionEdgeStart: closestOppositeDirectionEdgeStart
    }
  }

  commitOffset (offsetObj) {
    const backlog = new Backlog(offsetObj)
    if (!this.enabled) return
    return this.buckets
      .forTime(backlog.timestamp)
      .addBacklog(backlog)
  }

  _serializeBuckets () {
    // TimeBuckets
    const serializedBuckets = []
    const serializedBacklogs = []

    for (const [ timeNs, bucket ] of this.buckets.entries()) {
      const points = []

      // bucket: StatsBucket
      // stats: StatsPoint
      for (const stats of bucket._checkpoints.values()) {
        points.push(stats.encode())
      }

      serializedBuckets.push({
        Start: new Uint64(timeNs),
        Duration: new Uint64(this.bucketSizeNs),
        Stats: points
      })

      if (bucket._backlogs.size > 0) {
        for (const backlog of Object.values(bucket._backlogs)) {
          serializedBacklogs.push(backlog.encode())
        }
      }
    }

    this.buckets.clear()

    return {
      Stats: serializedBuckets,
      Backlogs: serializedBacklogs
    }
  }
}

module.exports = {
  DataStreamsProcessor: DataStreamsProcessor,
  StatsPoint: StatsPoint,
  StatsBucket: StatsBucket,
  TimeBuckets,
  ENTRY_PARENT_HASH
}
