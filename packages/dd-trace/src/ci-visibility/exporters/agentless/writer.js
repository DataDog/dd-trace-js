'use strict'
const request = require('../../../exporters/common/request')
const log = require('../../../log')

const { AgentlessCiVisibilityEncoder } = require('../../../encode/agentless-ci-visibility')
const { CoverageCIVisibilityEncoder } = require('../../../encode/coverage-ci-visibility')
const BaseWriter = require('../../../exporters/common/writer')

function safeJSONStringify (value) {
  return JSON.stringify(value, (key, value) =>
    key !== 'dd-api-key' ? value : undefined
  )
}

function getRequestOptions (url, path, extraHeaders) {
  const options = {
    path: path,
    method: 'POST',
    headers: {
      'dd-api-key': process.env.DATADOG_API_KEY || process.env.DD_API_KEY,
      ...extraHeaders
    },
    timeout: 15000
  }

  options.protocol = url.protocol
  options.hostname = url.hostname
  options.port = url.port

  return options
}

class Writer extends BaseWriter {
  constructor ({ url, tags, coverageUrl }) {
    super(...arguments)
    const { 'runtime-id': runtimeId, env, service } = tags
    this._url = url
    this._coverageUrl = coverageUrl
    this._encoder = new AgentlessCiVisibilityEncoder({ runtimeId, env, service })
    this._coverageEncoder = new CoverageCIVisibilityEncoder()
  }

  _sendPayloadBase (data, options, done) {
    log.debug(() => `Request to the intake: ${safeJSONStringify(options)}`)
    request(data, options, false, (err, res) => {
      if (err) {
        log.error(err)
        done()
        return
      }
      log.debug(`Response from the intake: ${res}`)
      done()
    })
  }

  _sendPayload (data, _, done) {
    const options = getRequestOptions(
      this._url,
      '/api/v2/citestcycle',
      { 'Content-Type': 'application/msgpack' }
    )
    this._sendPayloadBase(data, options, done)
  }

  _sendCoverage (form, done) {
    const options = getRequestOptions(
      this._coverageUrl,
      '/api/v2/citestcov',
      form.getHeaders()
    )
    this._sendPayloadBase(form, options, done)
  }

  appendCoverage (coverage) {
    this._coverageEncoder.encode(coverage)
  }

  flushCoverage (done = () => {}) {
    const count = this._coverageEncoder.count()

    if (!request.writable) {
      this._coverageEncoder.reset()
      done()
    } else if (count > 0) {
      const payload = this._coverageEncoder.makePayload()

      this._sendCoverage(payload, done)
    } else {
      done()
    }
  }
}

module.exports = Writer
