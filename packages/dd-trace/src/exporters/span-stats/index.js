'use strict'

const log = require('../../log')
const { createServerlessDeliveryTracker } = require('../../serverless')
const { Writer } = require('./writer')

class SpanStatsExporter {
  #serverlessDeliveryTracker

  /**
   * @param {object} config
   * @param {string|URL} config.url
   * @param {(payload: Buffer, done: () => void) => void} [config.sendStats]
   */
  constructor (config) {
    this.#serverlessDeliveryTracker = createServerlessDeliveryTracker()
    this._url = config.url
    this._writer = new Writer({
      url: this._url,
      sendStats: config.sendStats,
      deliveryTracker: this.#serverlessDeliveryTracker,
    })
  }

  export (payload, done) {
    try {
      this._writer.append(payload)
      this._writer.flush(this.#serverlessDeliveryTracker ? undefined : done)
    } catch (error) {
      if (!done) throw error
      log.error('Failed to flush span stats: %s', error.message)
    }
    this.#serverlessDeliveryTracker?.waitForIdle(done)
  }

  flush (done) {
    this._writer.flush(this.#serverlessDeliveryTracker ? undefined : done)
    this.#serverlessDeliveryTracker?.waitForIdle(done)
  }
}

module.exports = {
  SpanStatsExporter,
}
