'use strict'

const { DsmPathwayCodec } = require('./pathway')
const DataStreamsContext = require('./context')

class DataStreamsManager {
  constructor (processor) {
    this._dataStreamsProcessor = processor
  }

  setCheckpoint (edgeTags, span, payloadSize = 0) {
    const ctx = this._dataStreamsProcessor.setCheckpoint(
      edgeTags, span, DataStreamsContext.getDataStreamsContext(), payloadSize
    )
    DataStreamsContext.setDataStreamsContext(ctx)
    return ctx
  }

  decodeDataStreamsContext (carrier) {
    const ctx = DsmPathwayCodec.decode(carrier)
    // we erase the previous context everytime we decode a new one
    DataStreamsContext.setDataStreamsContext(ctx)
    return ctx
  }

  /**
   * @param {string} transactionId
   * @param {string} checkpointName
   * @param {object|null} [span=null]
   */
  trackTransaction (transactionId, checkpointName, span = null) {
    this._dataStreamsProcessor.trackTransaction(transactionId, checkpointName, span)
  }
}

module.exports = { DataStreamsManager }
