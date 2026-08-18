'use strict'

const { SpanStatsEncoder } = require('../../encode/span-stats')

const pkg = require('../../../../../package.json')

const BaseWriter = require('../common/writer')
const request = require('../common/request')
const log = require('../../log')

class Writer extends BaseWriter {
  #onFlush

  constructor ({ url, onFlush }) {
    super(...arguments)
    this._url = url
    this.#onFlush = onFlush
    this._encoder = new SpanStatsEncoder(this)
  }

  flush (done, options) {
    const flush = callback => this.flushDirect(callback, options)
    if (this.#onFlush) return this.#onFlush(flush, done)
    flush(done)
  }

  flushDirect (done, options) {
    super.flush(done, options)
  }

  _sendPayload (data, _, done) {
    makeRequest(data, this._url, (err, res) => {
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
