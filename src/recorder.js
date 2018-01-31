'use strict'

const Scheduler = require('./scheduler')
const Writer = require('./writer')

// TODO: make calls to Writer#append asynchronous

class Recorder {
  constructor (url, interval, size) {
    this._writer = new Writer(url, size)
    this._scheduler = new Scheduler(() => this._writer.flush(), interval)
  }

  init () {
    this._scheduler.start()
  }

  record (trace) {
    this._writer.append(trace)
  }
}

module.exports = Recorder
