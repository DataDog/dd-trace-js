'use strict'

const URL = require('url').URL
const Writer = require('./writer')
const Scheduler = require('../../../exporters/scheduler')

class AgentlessCiVisibilityExporter {
  constructor (config) {
    const { flushInterval, tags, site, url } = config
    this._url = url || new URL(`https://citestcycle-intake.${site}`)
    this._writer = new Writer({ url: this._url, tags })

    if (flushInterval > 0) {
      this._scheduler = new Scheduler(() => this._writer.flush(), flushInterval)
    }
    this._scheduler && this._scheduler.start()
  }

  export (trace) {
    this._writer.append(trace)

    if (!this._scheduler) {
      this._writer.flush()
    }
  }
}

module.exports = AgentlessCiVisibilityExporter
