'use strict'

const os = require('os')
const pkg = require('../../../../package.json')

const { LogCollapsingLowestDenseDDSketch } = require('../../../../vendor/dist/@datadog/sketches-js')
const { PATHWAY_HASH } = require('../../../../ext/tags')
const log = require('../log')
const processTags = require('../process-tags')
const propagationHash = require('../propagation-hash')
const { DsmPathwayCodec } = require('./pathway')
const { DataStreamsWriter } = require('./writer')
const { computePathwayHash } = require('./pathway')
const { getAmqpMessageSize, getHeadersSize, getMessageSize, getSizeOrZero } = require('./size')
const { SchemaBuilder } = require('./schemas/schema_builder')
const { SchemaSampler } = require('./schemas/schema_sampler')

const ENTRY_PARENT_HASH = Buffer.from('0000000000000000', 'hex')

class StatsPoint {
  constructor (hash, parentHash, edgeTags) {
    this.hash = hash.readBigUInt64LE()
    this.parentHash = parentHash.readBigUInt64LE()

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
      PayloadSize: this.payloadSize.toProto(),
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
      Value: this.offset,
    }
  }
}

/**
 * Maps checkpoint name strings to single-byte IDs (1–254).
 * ID 0 is reserved; 254 is the maximum number of unique names.
 * Scope is per-processor so IDs are stable across bucket boundaries within a process lifetime.
 */
class CheckpointRegistry {
  constructor () {
    /** @type {Map<string, number>} */
    this._nameToId = new Map()
    this._nextId = 1
    /** @type {Buffer[]} Pre-built [id uint8][nameLen uint8][name bytes] entries, one per registered name. */
    this._entryBuffers = []
    /** @type {Buffer | null} Cached concat of _entryBuffers; reset when a new name is added. */
    this._encodedKeysCache = null
  }

  /**
   * Returns the byte ID for the given checkpoint name, assigning one if not seen before.
   * Returns undefined when registry is full (254 entries exhausted).
   * @param {string} name
   * @returns {number | undefined}
   */
  getId (name) {
    const existing = this._nameToId.get(name)
    if (existing !== undefined) return existing
    if (this._nextId > 254) return
    const id = this._nextId++
    this._nameToId.set(name, id)
    // Build the wire entry now with a bounded write so long names never materialise
    // their full UTF-8 encoding — buf.write() stops at the supplied byte limit.
    const nameBuf = Buffer.allocUnsafe(255)
    const nameByteLen = nameBuf.write(name, 0, 255, 'utf8')
    const entry = Buffer.allocUnsafe(2 + nameByteLen)
    entry.writeUInt8(id, 0)
    entry.writeUInt8(nameByteLen, 1)
    nameBuf.copy(entry, 2, 0, nameByteLen)
    this._entryBuffers.push(entry)
    this._encodedKeysCache = null
    return id
  }

  /**
   * Returns a Buffer encoding all registered names as [id uint8][nameLen uint8][name bytes].
   * Names are truncated to 255 UTF-8 bytes.
   * Result is cached and only recomputed when new names are registered.
   * @returns {Buffer}
   */
  get encodedKeys () {
    if (this._encodedKeysCache !== null) return this._encodedKeysCache
    this._encodedKeysCache = this._entryBuffers.length > 0
      ? Buffer.concat(this._entryBuffers)
      : Buffer.alloc(0)
    return this._encodedKeysCache
  }
}

class StatsBucket {
  constructor () {
    this._checkpoints = new Map()
    this._backlogs = new Map()
    /** @type {Buffer[]} Accumulated transaction byte chunks, concatenated lazily. */
    this._transactionChunks = []
  }

  get checkpoints () {
    return this._checkpoints
  }

  get backlogs () {
    return this._backlogs
  }

  /**
   * Returns the concatenated transaction bytes, or null if no transactions have been added.
   * Concatenation is deferred to read time to avoid O(N²) copies during accumulation.
   * @returns {Buffer | null}
   */
  get transactions () {
    if (this._transactionChunks.length === 0) return null
    return Buffer.concat(this._transactionChunks)
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
   * Appends pre-encoded transaction bytes to this bucket.
   * @param {Buffer} bytes
   */
  addTransaction (bytes) {
    this._transactionChunks.push(bytes)
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
    flushInterval,
  } = {}) {
    this.writer = new DataStreamsWriter({
      hostname,
      port,
      url,
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
    this._checkpointRegistry = new CheckpointRegistry()

    if (this.enabled) {
      this.timer = setInterval(this.onInterval.bind(this), flushInterval)
      this.timer.unref()
    }
    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(this.onInterval.bind(this))
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
      Tags: Object.entries(this.tags).map(([key, value]) => `${key}:${value}`),
    }

    // Add ProcessTags only if feature is enabled and process tags exist
    if (propagationHash.isEnabled() && processTags.serialized) {
      payload.ProcessTags = processTags.serialized.split(',')
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
      span.setTag(PATHWAY_HASH, checkpoint.hash.readBigUInt64LE(0).toString())
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
        'Setting DSM Checkpoint from extracted parent context with hash: %s and edge tags: %s',
        parentHash,
        edgeTags
      )
    }

    // Get propagation hash if enabled
    const propagationHashValue = propagationHash.isEnabled() ? propagationHash.getHash() : null

    const hash = computePathwayHash(this.service, this.env, edgeTags, parentHash, propagationHashValue)
    const edgeLatencyNs = nowNs - edgeStartNs
    const pathwayLatencyNs = nowNs - pathwayStartNs
    const dataStreamsContext = {
      hash,
      edgeStartNs,
      pathwayStartNs,
      previousDirection: direction,
      closestOppositeDirectionHash,
      closestOppositeDirectionEdgeStart,
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
      payloadSize,
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
      timestamp: nowNs,
    }
    this.recordOffset(backlogData)
  }

  /**
   * Records a transaction ID at a named checkpoint using the binary wire format shared with Go/Java tracers.
   *
   * Wire format per entry: [checkpointId uint8][timestamp int64 big-endian 8 bytes][idLen uint8][id bytes]
   *
   * @param {string} transactionId - Truncated to 255 UTF-8 bytes.
   * @param {string} checkpointName - Mapped to a stable 1-byte ID; silently dropped if registry full.
   */
  trackTransaction (transactionId, checkpointName) {
    if (!this.enabled) {
      log.warn('trackTransaction called but DD_DATA_STREAMS_ENABLED is not set. Transaction will not be tracked.')
      return
    }

    const checkpointId = this._checkpointRegistry.getId(checkpointName)
    if (checkpointId === undefined) return

    const idBytes = Buffer.from(transactionId, 'utf8').subarray(0, 255)
    // Multiply as BigInt to avoid precision loss past MAX_SAFE_INTEGER
    const timestampNs = BigInt(Date.now()) * 1_000_000n

    const entry = Buffer.alloc(1 + 8 + 1 + idBytes.length)
    entry.writeUInt8(checkpointId, 0)
    entry.writeBigInt64BE(timestampNs, 1)
    entry.writeUInt8(idBytes.length, 9)
    idBytes.copy(entry, 10)

    // Number() cast is safe here: 10s bucket granularity tolerates ~0.5ns precision loss
    this.bucketFromTimestamp(Number(timestampNs)).addTransaction(entry)
  }

  _serializeBuckets () {
    // TimeBuckets
    const serializedBuckets = []
    const registrySnapshot = this._checkpointRegistry.encodedKeys

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

      const serializedBucket = {
        Start: BigInt(timeNs),
        Duration: BigInt(this.bucketSizeNs),
        Stats: points,
        Backlogs: backlogs,
      }

      const transactions = bucket.transactions
      if (transactions !== null) {
        serializedBucket.Transactions = transactions
        serializedBucket.TransactionCheckpointIds = registrySnapshot
      }

      serializedBuckets.push(serializedBucket)
    }

    this.buckets.clear()

    return {
      Stats: serializedBuckets,
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
  CheckpointRegistry,
  DataStreamsProcessor,
  StatsPoint,
  StatsBucket,
  Backlog,
  TimeBuckets,
  getMessageSize,
  getHeadersSize,
  getSizeOrZero,
  getAmqpMessageSize,
  ENTRY_PARENT_HASH,
}
