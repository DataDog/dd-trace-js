'use strict'

const log = require('../../log')
const { createServerlessDeliveryTracker } = require('../../serverless')
const { flushWriter, trackDelivery } = require('../common/flush')
const { Writer } = require('./writer')

class SpanStatsExporter {
  #serverlessDeliveryTracker

  constructor (config) {
    this.#serverlessDeliveryTracker = createServerlessDeliveryTracker()
    this._url = config.url
    this._writer = new Writer({
      url: this._url,
      onFlush: (flush, done) => trackDelivery(this.#serverlessDeliveryTracker, flush, done),
    })
  }

  export (payload, done) {
    this._writer.append(payload)
    try {
      flushWriter(
        this._writer,
        this.#serverlessDeliveryTracker,
        this.#serverlessDeliveryTracker ? undefined : done
      )
    } catch (error) {
      if (!done) throw error
      log.error('Failed to flush span stats: %s', error.message)
    }
    this.#serverlessDeliveryTracker?.waitForIdle(done)
  }

  flush (done) {
    flushWriter(
      this._writer,
      this.#serverlessDeliveryTracker,
      this.#serverlessDeliveryTracker ? undefined : done
    )
    this.#serverlessDeliveryTracker?.waitForIdle(done)
  }
}

module.exports = {
  SpanStatsExporter,
}
