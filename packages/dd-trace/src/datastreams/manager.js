'use strict'

const { DsmPathwayCodec } = require('./pathway')
const DataStreamsContext = require('./context')

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
   * @param {string} transactionId
   * @param {string} checkpointName
   * @param {object|null} [span]
   */
  trackTransaction (transactionId, checkpointName, span = null) {
    this._dataStreamsProcessor.trackTransaction(transactionId, checkpointName, span)
  }
}

module.exports = { DataStreamsManager }
