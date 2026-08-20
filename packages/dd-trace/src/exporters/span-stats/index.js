'use strict'

const log = require('../../log')
const PendingOperations = require('../common/pending-operations')
const { Writer } = require('./writer')

class SpanStatsExporter {
  #operations = new PendingOperations()

  constructor (config) {
    this._url = config.url
    this._writer = new Writer({ url: this._url, onFlush: this.#operations.track.bind(this.#operations) })
  }

  export (payload, done) {
    if (done) {
      this._writer.append(payload)
      try {
        this.#flush()
      } catch (error) {
        log.error('Failed to flush span stats: %s', error)
      }
      return this.#operations.wait(done)
    }
    this._writer.append(payload)
    this.#flush()
  }

  #flush () {
    const complete = this.#operations.start()
    try {
      this._writer.flushDirect(complete)
    } catch (error) {
      complete()
      throw error
    }
  }
}

module.exports = {
  SpanStatsExporter,
}
