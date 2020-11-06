'use strict'

const Writer = require('./writer')
const Scheduler = require('./scheduler')

const Config = require('../../config')

class AgentExporter {
  constructor (prioritySampler) {
    this._writer = new Writer(prioritySampler)

    Config.retroOn('update', ({ flushInterval, url }) => {
      if (flushInterval > 0) {
        this._scheduler = new Scheduler(() => this._writer.flush(), flushInterval)
        this._scheduler.start()
      }
      this._url = url
    })
  }

  export (spans) {
    this._writer.append(spans)

    if (!this._scheduler) {
      this._writer.flush()
    }
  }
}

module.exports = AgentExporter
