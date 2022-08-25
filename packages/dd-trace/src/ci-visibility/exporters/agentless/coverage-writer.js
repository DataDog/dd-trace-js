'use strict'
const request = require('../../../exporters/common/request')
const log = require('../../../log')

const { CoverageCIVisibilityEncoder } = require('../../../encode/coverage-ci-visibility')
const BaseWriter = require('../../../exporters/common/writer')

function safeJSONStringify (value) {
  return JSON.stringify(value, (key, value) =>
    key !== 'dd-api-key' ? value : undefined
  )
}

class Writer extends BaseWriter {
  constructor ({ url }) {
    super(...arguments)
    this._url = url
    this._encoder = new CoverageCIVisibilityEncoder()
  }

  _sendPayload (form, _, done) {
    const options = {
      path: '/api/v2/citestcov',
      method: 'POST',
      headers: {
        'dd-api-key': process.env.DATADOG_API_KEY || process.env.DD_API_KEY,
        ...form.getHeaders()
      },
      timeout: 15000
    }

    options.protocol = this._url.protocol
    options.hostname = this._url.hostname
    options.port = this._url.port

    log.debug(() => `Request to the intake: ${safeJSONStringify(options)}`)

    request(form, options, (err, res) => {
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

module.exports = Writer
