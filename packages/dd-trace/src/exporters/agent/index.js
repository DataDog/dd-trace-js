'use strict'

const Writer = require('./writer')
const Scheduler = require('./scheduler')

const config = require('../../config')

class AgentExporter {
  constructor (prioritySampler) {
    this._writer = new Writer(prioritySampler)

    config.retroOn('update', ({ flushInterval, url }) => {
      // TODO shouldn't the schedule handle config on its own?
      if (flushInterval > 0) {
        this._scheduler = new Scheduler(() => this._writer.flush(), flushInterval)
        this._scheduler.start()
      } else {
        if (this._scheduler) {
          this._scheduler.stop()
          delete this._scheduler
        }
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
