'use strict'

const DataStreamsContext = require('./context')

class DataStreamsCheckpointer {
  constructor (tracer) {
    this.tracer = tracer
    this.config = tracer._config
    this.dsmProcessor = tracer._dataStreamsProcessor
  }

  /**
   * @param {string} type - The type of the checkpoint, usually the streaming technology being used.
   *                       Examples include kafka, kinesis, sns etc.
   * @param {string} target - The target of data. This can be a topic, exchange or stream name.
   * @param {Object} carrier - The carrier object to inject context into.
   */
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

  /**
   * @param {string} type - The type of the checkpoint, usually the streaming technology being used.
   *                       Examples include kafka, kinesis, sns etc.
   * @param {string} source - The source of data. This can be a topic, exchange or stream name.
   * @param {Object} carrier - The carrier object to extract context from.
   * @param {boolean} [manualCheckpoint=true] - Whether this checkpoint was manually set. Keep true if manually instrumenting.
   *                                           Manual instrumentation always overrides automatic instrumentation in the case a call is both
   *                                           manually and automatically instrumented.
   */
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
