'use strict'

const Scheduler = require('./scheduler')
const Writer = require('./writer')

// TODO: make calls to Writer#append asynchronous

class Recorder {
  constructor (tracer) {
    this._writer = new Writer(tracer._url)
    this._tracer = tracer
  }

  record (trace) {
    if (!this._scheduler) {
      this._scheduler = new Scheduler(() => this._writer.flush(), this._tracer._flushDelay)
      this._scheduler.start()
    }

    if (this._writer.length < this._tracer._bufferSize) {
      this._writer.append(trace)
    } else {
      this._writer.flush()
      this._scheduler.reset()
    }
  }
}

module.exports = Recorder
