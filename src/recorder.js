'use strict'

const Scheduler = require('./scheduler')
const Writer = require('./writer')

// TODO: make calls to Writer#append asynchronous

class Recorder {
  constructor (url, interval, size) {
    this._writer = new Writer(url, size)

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
