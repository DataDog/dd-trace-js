'use strict'

const { Writer } = require('./writer')

class SpanStatsExporter {
  constructor (config) {
    this._url = config.url
    this._writer = new Writer({ url: this._url })
  }

  export (payload) {
    this._writer.append(payload)
    this._writer.flush()
  }
}

module.exports = {
  SpanStatsExporter,
}
