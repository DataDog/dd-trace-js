'use strict'

const { SpanStatsEncoder } = require('../../encode/span-stats')

const pkg = require('../../../../../package.json')

const BaseWriter = require('../common/writer')
const request = require('../common/request')
const log = require('../../log')

class Writer extends BaseWriter {
  #sendStats

  /**
   * @param {object} options
   * @param {string|URL} options.url
   * @param {(payload: Buffer, done: () => void) => void} [options.sendStats]
   * @param {import('../../serverless/telemetry-delivery-tracker')} [options.deliveryTracker]
   */
  constructor ({ url, sendStats, deliveryTracker }) {
    super({ url, deliveryTracker, beforeFirstFlush: undefined })
    this._url = url
    this.#sendStats = sendStats
    this._encoder = new SpanStatsEncoder(this)
  }

  /**
   * @param {Buffer} data
   * @param {number} _
   * @param {() => void} done
   */
  _sendPayload (data, _, done) {
    if (this.#sendStats) {
      this.#sendStats(data, done)
      return
    }

    makeRequest(data, this._url, (error, res) => {
      if (error) {
        log.error('Error sending span stats', error)
        done()
        return
      }
      log.debug('Response from the intake:', res)
      done()
    })
  }
}

function makeRequest (data, url, cb) {
  const options = {
    path: '/v0.6/stats',
    method: 'PUT',
    headers: {
      'Datadog-Meta-Lang': 'javascript',
      'Datadog-Meta-Tracer-Version': pkg.version,
      'Content-Type': 'application/msgpack',
    },
    url,
  }

  log.debug('Request to the intake: %j', options)

  request(data, options, (error, res) => {
    cb(error, res)
  })
}

module.exports = {
  Writer,
}
