'use strict'

const Writer = require('./writer')
const Scheduler = require('./scheduler')

class AgentExporter {

  constructor (url, interval) {
    this._writer = new Writer(url)

    if (interval > 0) {
      this._scheduler = new Scheduler(() => this._writer.flush(), interval)
    }
    this._scheduler && this._scheduler.start()
  }

  export (span) {
    this._writer.append(span)

    if (!this._scheduler) {
      this._writer.flush()
    }
  }
}

module.exports = AgentExporter
