'use strict'

class DataStreamsCheckpointerProxy {
  constructor (tracer) {
    this._tracer = tracer
  }

  setProduceCheckpoint (...args) {
    if (!this._tracer._config.dsmEnabled) return
    this._initialize()
    return this._checkpointer.setProduceCheckpoint(...args)
  }

  setConsumeCheckpoint (...args) {
    if (!this._tracer._config.dsmEnabled) return
    this._initialize()
    return this._checkpointer.setProduceCheckpoint(...args)
  }

  _initialize () {
    const { DataStreamsCheckpointer } = require('./data_streams')

    this._checkpointer = new DataStreamsCheckpointer(this._tracer)
    this._initialize = () => {}
  }
}

class DataStreamsManagerProxy {
  setCheckpoint (...args) {
    if (!this._manager) return null
    this._initialize()
    return this._manager.setCheckpoint(...args)
  }

  decodeDataStreamsContext (...args) {
    if (!this._manager) return
    this._initialize()
    return this._manager.decodeDataStreamsContext(...args)
  }

  setOffset (...args) {
    if (!this._manager) return
    this._initialize()
    return this._manager.decodeDataStreamsContext(...args)
  }

  _initialize () {
    const { DataStreamsManager } = require('./manager')

    this._manager = new DataStreamsManager(this._tracer)
    this._initialize = () => {}
  }
}

module.exports = {
  DataStreamsManagerProxy,
  DataStreamsCheckpointerProxy
}
