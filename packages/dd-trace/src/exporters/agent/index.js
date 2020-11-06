'use strict'

const URL = require('url-parse')
const log = require('../../log')
const Writer = require('./writer')
const Scheduler = require('./scheduler')

const Config = require('../../config')

class AgentExporter {
  constructor (prioritySampler) {
    const { url, hostname, port, flushInterval, lookup, protocolVersion } = Config.config
    this._url = url || new URL(`http://${hostname || 'localhost'}:${port}`)
    this._writer = new Writer({ url: this._url, prioritySampler, lookup, protocolVersion })

    if (flushInterval > 0) {
      this._scheduler = new Scheduler(() => this._writer.flush(), flushInterval)
    }
    this._scheduler && this._scheduler.start()
    Config.config.on('update', () => {
      const { url, hostname, port } = Config.config
      this.setUrl(url || `http://${hostname || 'localhost'}:${port}`)
    })
  }

  setUrl (url) {
    try {
      url = new URL(url)
      this._url = url
      this._writer.setUrl(url)
    } catch (e) {
      log.warn(e.stack)
    }
  }

  export (spans) {
    this._writer.append(spans)

    if (!this._scheduler) {
      this._writer.flush()
    }
  }
}

module.exports = AgentExporter
