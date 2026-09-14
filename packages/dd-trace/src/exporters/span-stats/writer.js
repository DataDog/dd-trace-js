'use strict'

const { SpanStatsEncoder } = require('../../encode/span-stats')

const pkg = require('../../../../../package.json')

const BaseWriter = require('../common/writer')
const request = require('../common/request')
const log = require('../../log')
const { IS_AWS_LAMBDA_MICROVM } = require('../../serverless')

class Writer extends BaseWriter {
  constructor ({ url }) {
    super(...arguments)
    this._url = url
    this._encoder = new SpanStatsEncoder(this)
    // Identity refresh is published only for Lambda MicroVM clones. Keep normal retry handling unchanged.
    this._identityRefreshController = IS_AWS_LAMBDA_MICROVM ? this._resetController : undefined
  }

  _sendPayload (data, _, done) {
    makeRequest(data, this._url, this._identityRefreshController, (err, res) => {
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

function makeRequest (data, url, resetController, cb) {
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
  if (resetController) options.resetController = resetController

  log.debug('Request to the intake: %j', options)

  request(data, options, (err, res) => {
    cb(err, res)
  })
}

module.exports = {
  Writer,
}
