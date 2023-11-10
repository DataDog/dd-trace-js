const os = require('os')
const pkg = require('../../../../package.json')
// Message pack int encoding is done in big endian, but data streams uses little endian
const Uint64 = require('int64-buffer').Uint64BE

const { LogCollapsingLowestDenseDDSketch } = require('@datadog/sketches-js')
const { encodePathwayContext } = require('./pathway')
const { DataStreamsWriter } = require('./writer')
const { computePathwayHash } = require('./pathway')
const { types } = require('util')
const { PATHWAY_HASH } = require('../../../../ext/tags')

const ENTRY_PARENT_HASH = Buffer.from('0000000000000000', 'hex')

const HIGH_ACCURACY_DISTRIBUTION = 0.0075
const CONTEXT_PROPAGATION_KEY = 'dd-pathway-ctx'

class StatsPoint {
  constructor (hash, parentHash, edgeTags) {
    this.hash = new Uint64(hash)
    this.parentHash = new Uint64(parentHash)
    this.edgeTags = edgeTags
    this.edgeLatency = new LogCollapsingLowestDenseDDSketch(HIGH_ACCURACY_DISTRIBUTION)
    this.pathwayLatency = new LogCollapsingLowestDenseDDSketch(HIGH_ACCURACY_DISTRIBUTION)
    this.payloadSize = new LogCollapsingLowestDenseDDSketch(HIGH_ACCURACY_DISTRIBUTION)
  }

  addLatencies (checkpoint) {
    const edgeLatencySec = checkpoint.edgeLatencyNs / 1e9
    const pathwayLatencySec = checkpoint.pathwayLatencyNs / 1e9
    this.edgeLatency.accept(edgeLatencySec)
    this.pathwayLatency.accept(pathwayLatencySec)
    this.payloadSize.accept(checkpoint.payloadSize)
  }

  encode () {
    return {
      Hash: this.hash,
      ParentHash: this.parentHash,
      EdgeTags: this.edgeTags,
      EdgeLatency: this.edgeLatency.toProto(),
      PathwayLatency: this.pathwayLatency.toProto(),
      PayloadSize: this.payloadSize.toProto()
    }
  }
}

class StatsBucket extends Map {
  forCheckpoint (checkpoint) {
    const key = checkpoint.hash
    if (!this.has(key)) {
      this.set(key, new StatsPoint(checkpoint.hash, checkpoint.parentHash, checkpoint.edgeTags)) // StatsPoint
    }

    return this.get(key)
  }
}

function getSizeOrZero (obj) {
  if (typeof obj === 'string') {
    return Buffer.from(obj, 'utf-8').length
  }
  if (types.isArrayBuffer(obj)) {
    return obj.byteLength
  }
  if (Buffer.isBuffer(obj)) {
    return obj.length
  }
  return 0
}

function getHeadersSize (headers) {
  if (headers === undefined) return 0
  return Object.entries(headers).reduce((prev, [key, val]) => getSizeOrZero(key) + getSizeOrZero(val) + prev, 0)
}

function getMessageSize (message) {
  const { key, value, headers } = message
  return getSizeOrZero(key) + getSizeOrZero(value) + getHeadersSize(headers)
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
    const serialized = this._serializeBuckets()
    if (!serialized) return
    const payload = {
      Env: this.env,
      Service: this.service,
      Stats: serialized,
      TracerVersion: pkg.version,
      Version: this.version,
      Lang: 'javascript'
    }
    this.writer.flush(payload)
  }

  recordCheckpoint (checkpoint, span = null) {
    if (!this.enabled) return
    const bucketTime = Math.round(checkpoint.currentTimestamp - (checkpoint.currentTimestamp % this.bucketSizeNs))
    this.buckets.forTime(bucketTime)
      .forCheckpoint(checkpoint)
      .addLatencies(checkpoint)
    // set DSM pathway hash on span to enable related traces feature on DSM tab, convert from buffer to uint64
    if (span) {
      span.setTag(PATHWAY_HASH, checkpoint.hash.readBigUInt64BE(0).toString())
    }
  }

  setCheckpoint (edgeTags, span, ctx = null, payloadSize = 0) {
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
    const dataStreamsContext = {
      hash: hash,
      edgeStartNs: edgeStartNs,
      pathwayStartNs: pathwayStartNs,
      previousDirection: direction,
      closestOppositeDirectionHash: closestOppositeDirectionHash,
      closestOppositeDirectionEdgeStart: closestOppositeDirectionEdgeStart
    }
    if (direction === 'direction:out') {
      // Add the header for this now, as the callee doesn't have access to context when producing
      payloadSize += getSizeOrZero(encodePathwayContext(dataStreamsContext))
      payloadSize += CONTEXT_PROPAGATION_KEY.length
    }
    const checkpoint = {
      currentTimestamp: nowNs,
      parentHash: parentHash,
      hash: hash,
      edgeTags: edgeTags,
      edgeLatencyNs: edgeLatencyNs,
      pathwayLatencyNs: pathwayLatencyNs,
      payloadSize: payloadSize
    }
    this.recordCheckpoint(checkpoint, span)
    return dataStreamsContext
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
  DataStreamsProcessor: DataStreamsProcessor,
  StatsPoint: StatsPoint,
  StatsBucket: StatsBucket,
  TimeBuckets,
  getMessageSize,
  getHeadersSize,
  getSizeOrZero,
  ENTRY_PARENT_HASH,
  CONTEXT_PROPAGATION_KEY
}
