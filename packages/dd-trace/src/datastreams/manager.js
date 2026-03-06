'use strict'

const { DsmPathwayCodec } = require('./pathway')
const DataStreamsContext = require('./context')

class DataStreamsManager {
  #dataStreamsProcessor

  constructor (processor) {
    this.#dataStreamsProcessor = processor
  }

  setCheckpoint (edgeTags, span, payloadSize = 0) {
    const ctx = this.#dataStreamsProcessor.setCheckpoint(
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
}

module.exports = { DataStreamsManager }
