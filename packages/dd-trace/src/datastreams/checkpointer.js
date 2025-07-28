'use strict'

const DataStreamsContext = require('./context')

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

  setConsumeCheckpoint (type, source, carrier, manualCheckpoint = true) {
    if (!this.config.dsmEnabled) return

    const parentCtx = this.tracer.extract('text_map_dsm', carrier)
    DataStreamsContext.setDataStreamsContext(parentCtx)

    const tags = ['type:' + type, 'topic:' + source, 'direction:in']
    if (manualCheckpoint) {
      tags.push('manual_checkpoint:true')
    }

    const ctx = this.dsmProcessor.setCheckpoint(
      tags,
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
