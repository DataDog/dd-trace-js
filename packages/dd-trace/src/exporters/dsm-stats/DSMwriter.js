
const { SpanStatsEncoder } = require('../../encode/span-stats') // TODO

const pkg = require('../../../../../package.json')

const BaseWriter = require('../common/writer')
const request = require('../common/request')
const log = require('../../log')

class DSMWriter extends BaseWriter {
  constructor ({ url }) {
    super(...arguments)
    this._url = url
    this._encoder = new SpanStatsEncoder(this)
  }

  _sendPayload (data, _, done) {
    makeRequest(data, this._url, (err, res) => {
      if (err) {
        log.error(err)
        done()
        return
      }
      log.debug(`Response from the intake: ${res}`)
      done()
    })
  }
}

function makeRequest (data, url, cb) {
  const options = {
    path: '/v0.1/pipeline_stats',
    method: 'POST',
    headers: {
      'Datadog-Meta-Lang': 'javascript',
      'Datadog-Meta-Tracer-Version': pkg.version,
      'Content-Type': 'application/msgpack'
    }
  }

  options.protocol = url.protocol
  options.hostname = url.hostname
  options.port = url.port

  log.debug(() => `Request to the intake: ${JSON.stringify(options)}`)

  request(data, options, (err, res) => {
    cb(err, res)
  })
}

module.exports = {
  DSMWriter
}
