'use strict'
const request = require('../../../exporters/common/request')
const log = require('../../../log')

const { AgentlessCiVisibilityEncoder } = require('../../../encode/agentless-ci-visibility')
const BaseWriter = require('../../../exporters/common/writer')

class Writer extends BaseWriter {
  constructor ({ url, tags }) {
    super(...arguments)
    const { 'runtime-id': runtimeId, env, service } = tags
    this._url = url
    this._encoder = new AgentlessCiVisibilityEncoder(this, { runtimeId, env, service })
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
    path: '/api/v2/citestcycle',
    method: 'POST',
    headers: {
      'Content-Type': 'application/msgpack',
      'dd-api-key': process.env.DATADOG_API_KEY || process.env.DD_API_KEY
    },
    timeout: 15000
  }

  options.protocol = url.protocol
  options.hostname = url.hostname
  options.port = url.port

  log.debug(() => `Request to the intake: ${JSON.stringify(options)}`)

  request(data, options, (err, res) => {
    cb(err, res)
  })
}

module.exports = Writer
