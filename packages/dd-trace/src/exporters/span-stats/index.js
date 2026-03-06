'use strict'

const { getAgentUrl } = require('../../agent/url')
const { Writer } = require('./writer')

class SpanStatsExporter {
  #url
  #writer

  constructor (config) {
    this.#url = getAgentUrl(config)
    this.#writer = new Writer({ url: this.#url })
  }

  export (payload) {
    this.#writer.append(payload)
    this.#writer.flush()
  }
}

module.exports = {
  SpanStatsExporter,
}
