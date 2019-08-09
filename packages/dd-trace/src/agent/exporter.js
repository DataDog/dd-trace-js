'use strict'

const Writer = require('./writer')
const Recorder = require('./recorder')

class AgentExporter {
  constructor (url, interval) {
    const writer = new Writer(url)
    this._recorder = new Recorder(writer, interval)
    this._recorder.init()
  }

  export (span) {
    this._recorder.record(span)
  }
}

module.exports = AgentExporter
