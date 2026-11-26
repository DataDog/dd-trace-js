'use strict'
const zlib = require('node:zlib')

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

  constructor ({ url, evpProxyPrefix = '', isGzipCompatible = false }) {
    super({ ...arguments[0], retainOnBackpressure: true })
    this.#requestTracker = new TestOptimizationRequestTracker(this)
    this._url = url
    this._encoder = new CoverageCIVisibilityEncoder(this)
    this._evpProxyPrefix = evpProxyPrefix
    this._isGzipCompatible = isGzipCompatible
  }

  /**
   * Flushes buffered coverage, waiting for tracked requests during finalization.
   *
   * @param {(error?: Error) => void} [done]
   * @param {{ deadline?: number }} [options]
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

    if (this._isGzipCompatible) options.headers['Content-Encoding'] = 'gzip'
    const send = this._isGzipCompatible ? requestGzipped : request
    this.#requestTracker.send(send, form, options, (err, res, statusCode) => {
      distributionMetric(
        TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_MS,
        { endpoint: 'code_coverage' },
        Date.now() - startRequestTime
      )
      if (err) {
        incrementCountMetric(
          TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_ERRORS,
          { endpoint: 'code_coverage', statusCode, errorType: statusCode ? undefined : err.code }
        )
        incrementCountMetric(
          TELEMETRY_ENDPOINT_PAYLOAD_DROPPED,
          { endpoint: 'code_coverage', statusCode, errorType: statusCode ? undefined : err.code }
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

/**
 * Sends a coverage form gzipped. Coverage repeats the same file names test after test and shrinks
 * about tenfold, and a short test run waits at exit for its whole coverage upload.
 *
 * @param {import('node:stream').Readable} form
 * @param {object} options
 * @param {(error: Error|null, response?: string, statusCode?: number) => void} callback
 */
function requestGzipped (form, options, callback) {
  const chunks = []
  form.on('data', chunk => { chunks.push(chunk) })
  form.once('error', callback)
  form.once('end', () => {
    zlib.gzip(Buffer.concat(chunks), { level: zlib.constants.Z_BEST_SPEED }, (error, body) => {
      if (error) return callback(error)
      request(body, options, callback)
    })
  })
}

module.exports = Writer
