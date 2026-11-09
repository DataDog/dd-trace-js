'use strict'

const { SpanStatsEncoder } = require('../../encode/span-stats')

const pkg = require('../../../../../package.json')

const BaseWriter = require('../common/writer')
const request = require('../common/request')
const log = require('../../log')

class Writer extends BaseWriter {
  #config

  /**
   * @param {Pick<import('../../config/config-base'), 'url'> & {
   *   deliveryTracker?: import('../../serverless/telemetry-delivery-tracker')
   * }} options
   * @param {Pick<import('../../config/config-base'), 'url'>} [config]
   */
  constructor (options, config = options) {
    super(/** @type {ConstructorParameters<typeof BaseWriter>[0]} */ (options))
    this.#config = config
    this._encoder = new SpanStatsEncoder(this)
  }

  _sendPayload (data, _, done) {
    makeRequest(data, this.#config.url, (err, res) => {
      if (err) {
        log.error('Error sending span stats', err)
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

  request(data, options, (err, res) => {
    cb(err, res)
  })
}

module.exports = {
  Writer,
}
