'use strict'
const request = require('../../../exporters/common/request')
const log = require('../../../log')
const { safeJSONStringify } = require('../../../exporters/common/util')

const { CoverageCIVisibilityEncoder } = require('../../../encode/coverage-ci-visibility')
const BaseWriter = require('../../../exporters/common/writer')
const {
  incrementCountMetric,
  distributionMetric,
  TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS,
  TELEMETRY_ENDPOINT_PAYLOAD_BYTES,
  TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_MS,
  TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_ERRORS,
  TELEMETRY_ENDPOINT_PAYLOAD_DROPPED,
  getErrorTypeFromStatusCode
} = require('../../../ci-visibility/telemetry')

class Writer extends BaseWriter {
  constructor ({ url, evpProxyPrefix = '' }) {
    super(...arguments)
    this._url = url
    this._encoder = new CoverageCIVisibilityEncoder(this)
    this._evpProxyPrefix = evpProxyPrefix
  }

  _sendPayload (form, _, done) {
    const options = {
      path: '/api/v2/citestcov',
      method: 'POST',
      headers: {
        'dd-api-key': process.env.DATADOG_API_KEY || process.env.DD_API_KEY,
        ...form.getHeaders()
      },
      timeout: 15000,
      url: this._url
    }

    if (this._evpProxyPrefix) {
      options.path = `${this._evpProxyPrefix}/api/v2/citestcov`
      delete options.headers['dd-api-key']
      options.headers['X-Datadog-EVP-Subdomain'] = 'citestcov-intake'
    }

    log.debug(() => `Request to the intake: ${safeJSONStringify(options)}`)

    const startRequestTime = Date.now()

    incrementCountMetric(TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS, { endpoint: 'code_coverage' })
    distributionMetric(TELEMETRY_ENDPOINT_PAYLOAD_BYTES, { endpoint: 'code_coverage' }, form.size())

    request(form, options, (err, res, statusCode) => {
      distributionMetric(
        TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_MS,
        { endpoint: 'code_coverage' },
        Date.now() - startRequestTime
      )
      if (err) {
        const errorType = getErrorTypeFromStatusCode(statusCode)
        incrementCountMetric(
          TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_ERRORS,
          { endpoint: 'code_coverage', errorType }
        )
        incrementCountMetric(
          TELEMETRY_ENDPOINT_PAYLOAD_DROPPED,
          { endpoint: 'code_coverage' }
        )
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
