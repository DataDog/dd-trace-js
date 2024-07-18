const DataStreamsContext = require('./data_streams_context')
const { DsmPathwayCodec } = require('./datastreams/processor')

class DataStreamsCheckpointer {
  constructor (config, dataStreamsProcessor) {
    this.enabled = config.dataStreamsEnabled
    this.processor = dataStreamsProcessor
  }

  setProduceCheckpoint (type, target, carrierSetter) {
    if (this.enabled) {
      const ctx = this.processor.setCheckpoint(
        ['type:' + type, 'topic:' + target, 'direction:out', 'manual_checkpoint:true'],
        null,
        DataStreamsContext.getDataStreamsContext(),
        null
      )
      DataStreamsContext.setDataStreamsContext(ctx)
      DsmPathwayCodec.encode(ctx, null, carrierSetter)

      return ctx
    }
  }

  setConsumeCheckpoint (type, source, carrierGetter) {
    if (this.enabled) {
      const parentCtx = DsmPathwayCodec.decode(null, carrierGetter)
      // we erase the previous context everytime we decode a new one
      DataStreamsContext.setDataStreamsContext(parentCtx)

      const ctx = this.processor.setCheckpoint(
        ['type:' + type, 'topic:' + source, 'direction:in', 'manual_checkpoint:true'],
        null,
        parentCtx,
        null
      )
      DataStreamsContext.setDataStreamsContext(ctx)

      return ctx
    }
  }
}

module.exports = {
  DataStreamsCheckpointer
}
