'use strict'
const request = require('./request')
const log = require('../../../log')

const { AgentlessCiVisibilityEncoder } = require('../../../encode/agentless-ci-visibility')

class Writer {
  constructor ({ url, tags }) {
    const { 'runtime-id': runtimeId, env, service } = tags
    this._url = url
    this._encoder = new AgentlessCiVisibilityEncoder({ runtimeId, env, service })
  }

  append (trace) {
    log.debug(() => `Appending trace: ${JSON.stringify(trace)}`)

    this._encoder.append(trace)
  }

  _sendPayload (data, done) {
    makeRequest(data, this._url, 15000, (err, res) => {
      if (err) {
        log.error(err)
        done()
        return
      }
      log.debug(`Response from the intake: ${res}`)
      done()
    })
  }

  flush (done = () => {}) {
    const count = this._encoder.count()

    if (count > 0) {
      const payload = this._encoder.makePayload()

      this._sendPayload(payload, done)
    } else {
      done()
    }
  }
}

function makeRequest (data, url, timeout, cb) {
  const options = {
    path: '/api/v2/citestcycle',
    method: 'POST',
    headers: {
      'Content-Type': 'application/msgpack',
      'dd-api-key': process.env.DATADOG_API_KEY || process.env.DD_API_KEY
    },
    timeout
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
