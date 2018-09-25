'use strict'

const Scheduler = require('./scheduler')

// TODO: make calls to Writer#append asynchronous

class Recorder {
  constructor (writer, interval) {
    this._writer = writer

    if (interval > 0) {
      this._scheduler = new Scheduler(() => this._writer.flush(), interval)
    }
  }

  init () {
    this._scheduler && this._scheduler.start()
  }

  record (span) {
    this._writer.append(span)

    if (!this._scheduler) {
      this._writer.flush()
    }
  }
}

module.exports = Recorder
