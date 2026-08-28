'use strict'
const getConfig = require('../../../config')
const { EVP_SUBDOMAIN_HEADER_NAME } = require('../../../evp_proxy/constants')
const { joinEVPProxyPath } = require('../../../evp_proxy/path')
const { safeJSONStringify } = require('../../../exporters/common/util')
const log = require('../../../log')

const {
  incrementCountMetric,
  distributionMetric,
  TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS,
  TELEMETRY_ENDPOINT_PAYLOAD_BYTES,
  TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_MS,
  TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_ERRORS,
  TELEMETRY_ENDPOINT_PAYLOAD_DROPPED,
} = require('../../../ci-visibility/telemetry')
const { CoverageCIVisibilityEncoder } = require('../../../encode/coverage-ci-visibility')
const BaseWriter = require('../../../exporters/common/writer')
const { getAgent } = require('../agents')
const request = require('../request')
const TestOptimizationRequestTracker = require('./request-tracker')

class Writer extends BaseWriter {
  #requestTracker

  constructor ({ url, evpProxyPrefix = '' }) {
    super({ ...arguments[0], retainOnBackpressure: true })
    this.#requestTracker = new TestOptimizationRequestTracker(this)
    this._url = url
    this._encoder = new CoverageCIVisibilityEncoder(this)
    this._evpProxyPrefix = evpProxyPrefix
  }

  /**
   * Flushes buffered coverage, waiting for tracked requests during finalization.
   *
   * @param {(error?: Error) => void} [done]
   * @param {{ deadline?: number }} [options]
   * @returns {void}
   */
  flush (done, options) {
    this.#requestTracker.flush(done, options)
  }

  _sendPayload (form, _, done, flushOptions) {
    const options = {
      path: '/api/v2/citestcov',
      method: 'POST',
      headers: {
        'dd-api-key': getConfig().DD_API_KEY,
        ...form.getHeaders(),
      },
      timeout: 15_000,
      url: this._url,
      agent: getAgent(this._url),
      deadline: flushOptions?.deadline,
    }

    if (this._evpProxyPrefix) {
      options.path = joinEVPProxyPath(this._evpProxyPrefix, '/api/v2/citestcov')
      delete options.headers['dd-api-key']
      options.headers[EVP_SUBDOMAIN_HEADER_NAME] = 'citestcov-intake'
    }

    // eslint-disable-next-line eslint-rules/eslint-log-printf-style
    log.debug(() => `Request to the intake: ${safeJSONStringify({ ...options, agent: undefined })}`)

    const startRequestTime = Date.now()

    incrementCountMetric(TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS, { endpoint: 'code_coverage' })
    distributionMetric(TELEMETRY_ENDPOINT_PAYLOAD_BYTES, { endpoint: 'code_coverage' }, form.size())

    this.#requestTracker.send(request, form, options, (err, res, statusCode) => {
      distributionMetric(
        TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_MS,
        { endpoint: 'code_coverage' },
        Date.now() - startRequestTime
      )
      if (err) {
        incrementCountMetric(
          TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_ERRORS,
          { endpoint: 'code_coverage', statusCode }
        )
        incrementCountMetric(
          TELEMETRY_ENDPOINT_PAYLOAD_DROPPED,
          { endpoint: 'code_coverage' }
        )
        log.error('Error sending CI coverage payload', err)
        done(err)
        return
      }
      log.debug('Response from the intake:', res)
      done()
    })
  }
}

module.exports = Writer
