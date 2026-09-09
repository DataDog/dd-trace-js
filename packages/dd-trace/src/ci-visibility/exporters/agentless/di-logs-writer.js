'use strict'
const getConfig = require('../../../config')
const log = require('../../../log')
const { safeJSONStringify } = require('../../../exporters/common/util')
const { JSONEncoder } = require('../../encode/json-encoder')
const { DEBUGGER_INPUT_V1 } = require('../../../debugger/constants')
const BaseWriter = require('../../../exporters/common/writer')
const {
  incrementCountMetric,
  TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_ERRORS,
  TELEMETRY_ENDPOINT_PAYLOAD_DROPPED,
} = require('../../../ci-visibility/telemetry')

const { getAgent } = require('../agents')
const { MAX_DI_LOG_BUFFERED_BYTES } = require('../limits')
const request = require('../request')
const TestOptimizationRequestTracker = require('./request-tracker')

// Writer used by the integration between Dynamic Instrumentation and Test Visibility
// It is used to encode and send logs to both the logs intake directly and the
// `/debugger/v1/input` endpoint in the agent, which is a proxy to the logs intake.
class DynamicInstrumentationLogsWriter extends BaseWriter {
  #requestTracker

  // TODO: what's a good value for timeout for the logs intake?
  constructor ({ url, timeout = 15_000, isAgentProxy = false }) {
    super({ ...arguments[0], retainOnBackpressure: true })
    this.#requestTracker = new TestOptimizationRequestTracker(this)
    this._url = url
    this._encoder = new JSONEncoder(MAX_DI_LOG_BUFFERED_BYTES)
    this._isAgentProxy = isAgentProxy
    this.timeout = timeout
  }

  /**
   * Flushes buffered logs, waiting for tracked requests during finalization.
   *
   * @param {(error?: Error) => void} [done]
   * @param {{ deadline?: number }} [options]
   * @returns {void}
   */
  flush (done, options) {
    this.#requestTracker.flush(done, options)
  }

  _sendPayload (data, _, done, flushOptions) {
    const options = {
      path: '/api/v2/logs',
      method: 'POST',
      headers: {
        'dd-api-key': getConfig().DD_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: this.timeout,
      url: this._url,
      agent: getAgent(this._url),
      deadline: flushOptions?.deadline,
    }

    if (this._isAgentProxy) {
      delete options.headers['dd-api-key']
      options.path = DEBUGGER_INPUT_V1
    }

    // eslint-disable-next-line eslint-rules/eslint-log-printf-style
    log.debug(() => `Request to the logs intake: ${safeJSONStringify({ ...options, agent: undefined })}`)

    this.#requestTracker.send(request, data, options, (err, res, statusCode) => {
      if (err) {
        incrementCountMetric(
          TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_ERRORS,
          { endpoint: 'di_logs', statusCode, errorType: statusCode ? undefined : err.code }
        )
        incrementCountMetric(
          TELEMETRY_ENDPOINT_PAYLOAD_DROPPED,
          { endpoint: 'di_logs', statusCode, errorType: statusCode ? undefined : err.code }
        )
        log.error('Error sending DI logs payload', err)
        done(err)
        return
      }
      log.debug('Response from the logs intake:', res)
      done()
    })
  }
}

module.exports = DynamicInstrumentationLogsWriter
