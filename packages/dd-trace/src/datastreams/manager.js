'use strict'

const { DataStreamsProcessor } = require('./processor')
const { DsmPathwayCodec } = require('./pathway')
const DataStreamsContext = require('./data_streams_context')

class DataStreamsManager {
  constructor (tracer) {
    this._dataStreamsProcessor = new DataStreamsProcessor(tracer._config)
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

  setOffset (offsetData) {
    return this._dataStreamsProcessor.setOffset(offsetData)
  }

  setUrl (url) {
    this._dataStreamsProcessor.setUrl(url)
  }
}

module.exports = { DataStreamsManager }
