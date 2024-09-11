const DataStreamsContext = require('./data_streams_context')

class DataStreamsCheckpointer {
  constructor (tracer) {
    this.tracer = tracer
    this.config = tracer._config
    this.dsmProcessor = tracer._dataStreamsProcessor
  }

  setProduceCheckpoint (type, target, carrier) {
    if (!this.config.dsmEnabled) return

    const ctx = this.dsmProcessor.setCheckpoint(
      ['type:' + type, 'topic:' + target, 'direction:out', 'manual_checkpoint:true'],
      null,
      DataStreamsContext.getDataStreamsContext(),
      null
    )
    DataStreamsContext.setDataStreamsContext(ctx)

    this.tracer.inject(ctx, 'text_map_dsm', carrier)
  }

  setConsumeCheckpoint (type, source, carrier) {
    if (!this.config.dsmEnabled) return

    const parentCtx = this.tracer.extract('text_map_dsm', carrier)
    DataStreamsContext.setDataStreamsContext(parentCtx)

    const ctx = this.dsmProcessor.setCheckpoint(
      ['type:' + type, 'topic:' + source, 'direction:in', 'manual_checkpoint:true'],
      null,
      parentCtx,
      null
    )
    DataStreamsContext.setDataStreamsContext(ctx)

    return ctx
  }
}

module.exports = {
  DataStreamsCheckpointer
}
