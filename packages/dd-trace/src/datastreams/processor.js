'use strict'

const os = require('os')
const pkg = require('../../../../package.json')

const { LogCollapsingLowestDenseDDSketch } = require('@datadog/sketches-js')
const { DsmPathwayCodec } = require('./pathway')
const { DataStreamsWriter } = require('./writer')
const { computePathwayHash } = require('./pathway')
const { getAmqpMessageSize, getHeadersSize, getMessageSize, getSizeOrZero } = require('./size')
const { PATHWAY_HASH } = require('../../../../ext/tags')
const { SchemaBuilder } = require('./schemas/schema_builder')
const { SchemaSampler } = require('./schemas/schema_sampler')
const log = require('../log')

const ENTRY_PARENT_HASH = Buffer.from('0000000000000000', 'hex')

class StatsPoint {
  constructor (hash, parentHash, edgeTags) {
    this.hash = hash.readBigUInt64BE()
    this.parentHash = parentHash.readBigUInt64BE()
    this.edgeTags = edgeTags
    this.edgeLatency = new LogCollapsingLowestDenseDDSketch()
    this.pathwayLatency = new LogCollapsingLowestDenseDDSketch()
    this.payloadSize = new LogCollapsingLowestDenseDDSketch()
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

class Backlog {
  constructor ({ offset, ...tags }) {
    this._tags = Object.keys(tags).sort().map(key => `${key}:${tags[key]}`)
    this._hash = this._tags.join(',')
    this._offset = offset
  }

  get hash () { return this._hash }

  get offset () { return this._offset }

  get tags () { return this._tags }

  encode () {
    return {
      Tags: this.tags,
      Value: this.offset
    }
  }
}

class StatsBucket {
  constructor () {
    this._checkpoints = new Map()
    this._backlogs = new Map()
  }

  get checkpoints () {
    return this._checkpoints
  }

  get backlogs () {
    return this._backlogs
  }

  forCheckpoint ({ hash, parentHash, edgeTags }) {
    let checkpoint = this._checkpoints.get(hash)
    if (!checkpoint) {
      checkpoint = new StatsPoint(hash, parentHash, edgeTags)
      this._checkpoints.set(hash, checkpoint)
    }

    return checkpoint
  }

  /**
   * Conditionally add a backlog to the bucket. If there is currently an offset
   * matching the backlog's tags, overwrite the offset IFF the backlog's offset
   * is greater than the recorded offset.
   *
   * @typedef {{[key: string]: string}} BacklogData
   * @property {number} offset
   *
   * @param {BacklogData} backlogData
   * @returns {Backlog}
   */
  forBacklog (backlogData) {
    const backlog = new Backlog(backlogData)
    const existingBacklog = this._backlogs.get(backlog.hash)
    if (existingBacklog !== undefined && existingBacklog.offset > backlog.offset) {
      return existingBacklog
    }
    this._backlogs.set(backlog.hash, backlog)
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
    service,
    flushInterval
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
    this.flushInterval = flushInterval
    this._schemaSamplers = {}

    if (this.enabled) {
      this.timer = setInterval(this.onInterval.bind(this), flushInterval)
      this.timer.unref()
    }
    process.once('beforeExit', () => this.onInterval())
  }

  onInterval () {
    const { Stats } = this._serializeBuckets()
    if (Stats.length === 0) return
    const payload = {
      Env: this.env,
      Service: this.service,
      Stats,
      TracerVersion: pkg.version,
      Version: this.version,
      Lang: 'javascript',
      Tags: Object.entries(this.tags).map(([key, value]) => `${key}:${value}`)
    }
    this.writer.flush(payload)
  }

  /**
   * Given a timestamp in nanoseconds, compute and return the closest TimeBucket
   * @param {number} timestamp
   * @returns {StatsBucket}
   */
  bucketFromTimestamp (timestamp) {
    const bucketTime = Math.round(timestamp - (timestamp % this.bucketSizeNs))
    const bucket = this.buckets.forTime(bucketTime)
    return bucket
  }

  recordCheckpoint (checkpoint, span = null) {
    if (!this.enabled) return
    this.bucketFromTimestamp(checkpoint.currentTimestamp)
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
    if (ctx == null) {
      log.debug('Setting DSM Checkpoint with empty parent context.')
    } else {
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
      log.debug(
        () => `Setting DSM Checkpoint from extracted parent context with hash: ${parentHash} and edge tags: ${edgeTags}`
      )
    }
    const hash = computePathwayHash(this.service, this.env, edgeTags, parentHash)
    const edgeLatencyNs = nowNs - edgeStartNs
    const pathwayLatencyNs = nowNs - pathwayStartNs
    const dataStreamsContext = {
      hash,
      edgeStartNs,
      pathwayStartNs,
      previousDirection: direction,
      closestOppositeDirectionHash,
      closestOppositeDirectionEdgeStart
    }
    if (direction === 'direction:out') {
      // Add the header for this now, as the callee doesn't have access to context when producing
      // - 1 to account for extra byte for {
      const ddInfoContinued = {}
      DsmPathwayCodec.encode(dataStreamsContext, ddInfoContinued)
      payloadSize += getSizeOrZero(JSON.stringify(ddInfoContinued)) - 1
    }
    const checkpoint = {
      currentTimestamp: nowNs,
      parentHash,
      hash,
      edgeTags,
      edgeLatencyNs,
      pathwayLatencyNs,
      payloadSize
    }
    this.recordCheckpoint(checkpoint, span)
    return dataStreamsContext
  }

  recordOffset ({ timestamp, ...backlogData }) {
    if (!this.enabled) return
    return this.bucketFromTimestamp(timestamp)
      .forBacklog(backlogData)
  }

  setOffset (offsetObj) {
    if (!this.enabled) return
    const nowNs = Date.now() * 1e6
    const backlogData = {
      ...offsetObj,
      timestamp: nowNs
    }
    this.recordOffset(backlogData)
  }

  _serializeBuckets () {
    // TimeBuckets
    const serializedBuckets = []

    for (const [timeNs, bucket] of this.buckets.entries()) {
      const points = []

      // bucket: StatsBucket
      // stats: StatsPoint
      for (const stats of bucket._checkpoints.values()) {
        points.push(stats.encode())
      }

      const backlogs = []
      for (const backlog of bucket._backlogs.values()) {
        backlogs.push(backlog.encode())
      }
      serializedBuckets.push({
        Start: BigInt(timeNs),
        Duration: BigInt(this.bucketSizeNs),
        Stats: points,
        Backlogs: backlogs
      })
    }

    this.buckets.clear()

    return {
      Stats: serializedBuckets
    }
  }

  setUrl (url) {
    this.writer.setUrl(url)
  }

  trySampleSchema (topic) {
    const nowMs = Date.now()

    if (!this._schemaSamplers[topic]) {
      this._schemaSamplers[topic] = new SchemaSampler()
    }

    const sampler = this._schemaSamplers[topic]
    return sampler.trySample(nowMs)
  }

  canSampleSchema (topic) {
    const nowMs = Date.now()

    if (!this._schemaSamplers[topic]) {
      this._schemaSamplers[topic] = new SchemaSampler()
    }

    const sampler = this._schemaSamplers[topic]
    return sampler.canSample(nowMs)
  }

  getSchema (schemaName, iterator) {
    return SchemaBuilder.getSchema(schemaName, iterator)
  }
}

module.exports = {
  DataStreamsProcessor,
  StatsPoint,
  StatsBucket,
  Backlog,
  TimeBuckets,
  getMessageSize,
  getHeadersSize,
  getSizeOrZero,
  getAmqpMessageSize,
  ENTRY_PARENT_HASH
}
