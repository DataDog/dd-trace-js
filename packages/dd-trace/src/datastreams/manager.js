'use strict'

const { DsmPathwayCodec } = require('./pathway')
const DataStreamsContext = require('./context')

/**
 * A synchronous run of checkpoints (for example the messages of one producer batch) that leaves the store as one
 * `DataStreamsManager#setCheckpoint` per checkpoint would, but enters it once, in `end()`, instead of once per
 * checkpoint. Each checkpoint's parent is the previous checkpoint's context; the first one's is the store's.
 */
class DataStreamsCheckpointRun {
  #processor
  #ctx
  #checkpointed = false

  /**
   * @param {import('./processor').DataStreamsProcessor} processor
   */
  constructor (processor) {
    this.#processor = processor
    this.#ctx = DataStreamsContext.getDataStreamsContext()
  }

  /**
   * @param {string[]} edgeTags
   * @param {import('../opentracing/span')|null} span
   * @param {number} [payloadSize]
   * @param {number} [pathwayContextSize] See `DataStreamsProcessor#setCheckpoint`.
   * @returns {object|undefined}
   */
  setCheckpoint (edgeTags, span, payloadSize = 0, pathwayContextSize) {
    const ctx = this.#processor.setCheckpoint(edgeTags, span, this.#ctx || null, payloadSize, pathwayContextSize)
    this.#ctx = ctx
    this.#checkpointed = true
    return ctx
  }

  /**
   * Call in a `finally`: a throwing checkpoint leaves the store at the last successful one, as one
   * `DataStreamsManager#setCheckpoint` per checkpoint would.
   */
  end () {
    if (this.#checkpointed) DataStreamsContext.setDataStreamsContext(this.#ctx)
  }
}

class DataStreamsManager {
  constructor (processor) {
    this._dataStreamsProcessor = processor
  }

  /**
   * @param {string[]} edgeTags
   * @param {import('../opentracing/span')|null} span
   * @param {number} [payloadSize]
   * @param {number} [pathwayContextSize] See `DataStreamsProcessor#setCheckpoint`.
   * @returns {object|undefined}
   */
  setCheckpoint (edgeTags, span, payloadSize = 0, pathwayContextSize) {
    const ctx = this._dataStreamsProcessor.setCheckpoint(
      edgeTags, span, DataStreamsContext.getDataStreamsContext(), payloadSize, pathwayContextSize
    )
    DataStreamsContext.setDataStreamsContext(ctx)
    return ctx
  }

  /**
   * @param {Record<string, string>|undefined} carrier Pass every message's carrier, including the
   *   ones without a context: that is what starts a new pathway instead of extending the previous
   *   message's.
   */
  decodeDataStreamsContext (carrier) {
    const ctx = DsmPathwayCodec.decode(carrier)
    DataStreamsContext.setDataStreamsContext(ctx)
    return ctx
  }

  /**
   * Same end state as `decodeDataStreamsContext(carrier)` followed by `setCheckpoint(...)`, with one store entry
   * instead of two.
   *
   * @param {Record<string, string>|undefined} carrier See `decodeDataStreamsContext`.
   * @param {string[]} edgeTags
   * @param {import('../opentracing/span')|null} span
   * @param {number} [payloadSize]
   * @param {number} [pathwayContextSize] See `DataStreamsProcessor#setCheckpoint`.
   * @returns {object|undefined}
   */
  _decodeAndSetCheckpoint (carrier, edgeTags, span, payloadSize = 0, pathwayContextSize) {
    const parentCtx = DsmPathwayCodec.decode(carrier)
    let ctx = parentCtx
    try {
      ctx = this._dataStreamsProcessor.setCheckpoint(edgeTags, span, parentCtx || null, payloadSize, pathwayContextSize)
    } finally {
      // If the checkpoint throws, the store holds the decoded context, as after `decodeDataStreamsContext`.
      DataStreamsContext.setDataStreamsContext(ctx)
    }
    return ctx
  }

  /**
   * @returns {DataStreamsCheckpointRun}
   */
  _startCheckpointRun () {
    return new DataStreamsCheckpointRun(this._dataStreamsProcessor)
  }

  /**
   * @param {string} transactionId
   * @param {string} checkpointName
   * @param {object|null} [span]
   */
  trackTransaction (transactionId, checkpointName, span = null) {
    this._dataStreamsProcessor.trackTransaction(transactionId, checkpointName, span)
  }
}

module.exports = { DataStreamsManager }
