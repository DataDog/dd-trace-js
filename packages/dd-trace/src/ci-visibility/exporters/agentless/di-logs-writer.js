'use strict'
const request = require('../../../exporters/common/request')
const log = require('../../../log')
const { safeJSONStringify } = require('../../../exporters/common/util')
const { JSONEncoder } = require('../../encode/json-encoder')

const BaseWriter = require('../../../exporters/common/writer')

// Writer used by the integration between Dynamic Instrumentation and Test Visibility
// It is used to encode and send logs to both the logs intake directly and the
// `/debugger/v1/input` endpoint in the agent, which is a proxy to the logs intake.
class DynamicInstrumentationLogsWriter extends BaseWriter {
  constructor ({ url, timeout, isAgentProxy = false }) {
    super(...arguments)
    this._url = url
    this._encoder = new JSONEncoder()
    this._isAgentProxy = isAgentProxy
    this.timeout = timeout
  }

  _sendPayload (data, _, done) {
    const options = {
      path: '/api/v2/logs',
      method: 'POST',
      headers: {
        'dd-api-key': process.env.DATADOG_API_KEY || process.env.DD_API_KEY,
        'Content-Type': 'application/json'
      },
      // TODO: what's a good value for timeout for the logs intake?
      timeout: this.timeout || 15000,
      url: this._url
    }

    if (this._isAgentProxy) {
      delete options.headers['dd-api-key']
      options.path = '/debugger/v1/input'
    }

    log.debug(() => `Request to the logs intake: ${safeJSONStringify(options)}`)

    request(data, options, (err, res) => {
      if (err) {
        log.error('Error sending DI logs payload', err)
        done()
        return
      }
      log.debug(`Response from the logs intake: ${res}`)
      done()
    })
  }
}

module.exports = DynamicInstrumentationLogsWriter
