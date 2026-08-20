'use strict'

const log = require('../../log')
const { createServerlessDeliveryTracker } = require('../../serverless')
const { Writer } = require('./writer')

class SpanStatsExporter {
  #serverlessDeliveryTracker

  constructor (config) {
    this.#serverlessDeliveryTracker = createServerlessDeliveryTracker()
    this._url = config.url
    this._writer = new Writer({ url: this._url, onFlush: this.#trackWriterFlush.bind(this) })
  }

  export (payload, done) {
    this._writer.append(payload)
    try {
      this.#flush(this.#serverlessDeliveryTracker ? undefined : done)
    } catch (error) {
      if (!done) throw error
      log.error('Failed to flush span stats: %s', error.message)
    }
    this.#serverlessDeliveryTracker?.waitForIdle(done)
  }

  flush (done) {
    this.#flush(this.#serverlessDeliveryTracker ? undefined : done)
    this.#serverlessDeliveryTracker?.waitForIdle(done)
  }

  #flush (done) {
    const flushWriter = this._writer.flushDirect ?? this._writer.flush
    if (this.#serverlessDeliveryTracker) {
      return this.#serverlessDeliveryTracker.track(flushWriter.bind(this._writer), done)
    }
    flushWriter.call(this._writer, done)
  }

  #trackWriterFlush (flush, done) {
    if (this.#serverlessDeliveryTracker) return this.#serverlessDeliveryTracker.track(flush, done)
    flush(done)
  }
}

module.exports = {
  SpanStatsExporter,
}
