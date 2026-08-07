'use strict'
const getConfig = require('../../../config')
const request = require('../../../exporters/common/request')
const log = require('../../../log')
const { safeJSONStringify } = require('../../../exporters/common/util')

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
const TestOptimizationWriter = require('./base-writer')

class Writer extends TestOptimizationWriter {
  constructor ({ url, evpProxyPrefix = '' }) {
    super(...arguments)
    this._url = url
    this._encoder = new CoverageCIVisibilityEncoder(this)
    this._evpProxyPrefix = evpProxyPrefix
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
      deadline: flushOptions?.deadline,
      retryOnHttpError: flushOptions?.deadline !== undefined,
    }

    if (this._evpProxyPrefix) {
      options.path = `${this._evpProxyPrefix}/api/v2/citestcov`
      delete options.headers['dd-api-key']
      options.headers['X-Datadog-EVP-Subdomain'] = 'citestcov-intake'
    }

    // eslint-disable-next-line eslint-rules/eslint-log-printf-style
    log.debug(() => `Request to the intake: ${safeJSONStringify(options)}`)

    const startRequestTime = Date.now()

    incrementCountMetric(TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS, { endpoint: 'code_coverage' })
    distributionMetric(TELEMETRY_ENDPOINT_PAYLOAD_BYTES, { endpoint: 'code_coverage' }, form.size())

    this._sendRequest(request, form, options, (err, res, statusCode) => {
      distributionMetric(
        TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_MS,
        { endpoint: 'code_coverage' },
        Date.now() - startRequestTime
      )
      if (err) {
        const reason = err.code === 'ABORT_ERR' || err.code === 'ERR_DD_TEST_OPTIMIZATION_FLUSH_TIMEOUT'
          ? 'final_flush_timeout'
          : (statusCode ? 'http_error' : 'network_error')
        incrementCountMetric(
          TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_ERRORS,
          { endpoint: 'code_coverage', statusCode }
        )
        incrementCountMetric(
          TELEMETRY_ENDPOINT_PAYLOAD_DROPPED,
          { endpoint: 'code_coverage', reason }
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
