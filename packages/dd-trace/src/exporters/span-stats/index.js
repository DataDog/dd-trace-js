'use strict'

const { getAgentUrl } = require('../../agent/url')
const { Writer } = require('./writer')

class SpanStatsExporter {
  constructor (config) {
    this._url = getAgentUrl(config)
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
