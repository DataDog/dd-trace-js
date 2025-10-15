'use strict'

const { URL, format } = require('url')

const { Writer } = require('./writer')
const defaults = require('../../config_defaults')

class SpanStatsExporter {
  constructor (config) {
    const { hostname = defaults.hostname, port = defaults.port, tags, url } = config
    this._url = url || new URL(format({
      protocol: 'http:',
      hostname,
      port
    }))
    this._writer = new Writer({ url: this._url, tags })
  }

  export (payload) {
    this._writer.append(payload)
    this._writer.flush()
  }
}

module.exports = {
  SpanStatsExporter
}
