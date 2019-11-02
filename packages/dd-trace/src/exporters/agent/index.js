'use strict'

const URL = require('url-parse')
const Writer = require('./writer')
const Scheduler = require('./scheduler')

class AgentExporter {
  constructor ({ url, hostname, port, flushInterval }, prioritySampler) {
    this._url = url || new URL(`http://${hostname || 'localhost'}:${port}`)
    this._writer = new Writer(this._url, prioritySampler)

    if (flushInterval > 0) {
      this._scheduler = new Scheduler(() => this._writer.flush(), flushInterval)
    }
    this._scheduler && this._scheduler.start()
  }

  export (spans) {
    this._writer.append(spans)

    if (!this._scheduler) {
      this._writer.flush()
    }
  }
}

module.exports = AgentExporter
