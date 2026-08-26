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
const { AgentlessCiVisibilityEncoder } = require('../../../encode/agentless-ci-visibility')
const { MAX_SIZE } = require('../../../msgpack')
const BaseWriter = require('../../../exporters/common/writer')
const { getAgent, isOriginSaturated } = require('../agents')
const request = require('../request')
const TestOptimizationRequestTracker = require('./request-tracker')

class Writer extends BaseWriter {
  #requestTracker

  constructor ({ url, tags, evpProxyPrefix = '' }) {
    super(...arguments)
    this.#requestTracker = new TestOptimizationRequestTracker(this)
    const { 'runtime-id': runtimeId, env, service } = tags
    this._url = url
    this._encoder = new AgentlessCiVisibilityEncoder(this, { runtimeId, env, service })
    this._evpProxyPrefix = evpProxyPrefix
  }

  /**
   * Flushes buffered events, coalescing size-gated flushes while the intake is busy.
   *
   * The encoder's size gate calls this without a deadline. When the intake origin is
   * saturated, defer so events coalesce instead of stacking another request behind
   * the in-flight ones; the periodic timer (which re-arms while saturated) and the
   * bounded final flush still deliver. Flush unconditionally near the encoder hard
   * cap so a saturated intake cannot grow the buffer into an `OverflowError` that
   * drops the whole payload.
   *
   * @param {(error?: Error) => void} [done]
   * @param {{ deadline?: number }} [options]
   * @returns {void}
   */
  flush (done, options) {
    if (options?.deadline === undefined && isOriginSaturated(this._url) &&
        (this._encoder?._traceBytes?.length ?? 0) < MAX_SIZE * 0.8) {
      done?.()
      return
    }
    this.#requestTracker.flush(done, options)
  }

  _sendPayload (data, _, done, flushOptions) {
    const options = {
      path: '/api/v2/citestcycle',
      method: 'POST',
      headers: {
        'dd-api-key': getConfig().DD_API_KEY,
        'Content-Type': 'application/msgpack',
      },
      timeout: 15_000,
      url: this._url,
      agent: getAgent(this._url),
      deadline: flushOptions?.deadline,
    }

    if (this._evpProxyPrefix) {
      options.path = joinEVPProxyPath(this._evpProxyPrefix, '/api/v2/citestcycle')
      delete options.headers['dd-api-key']
      options.headers[EVP_SUBDOMAIN_HEADER_NAME] = 'citestcycle-intake'
    }

    // Agents carry live socket state while requests are active; omit them from debug output.
    // eslint-disable-next-line eslint-rules/eslint-log-printf-style
    log.debug(() => `Request to the intake: ${safeJSONStringify({ ...options, agent: undefined })}`)

    const startRequestTime = Date.now()

    incrementCountMetric(TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS, { endpoint: 'test_cycle' })
    distributionMetric(TELEMETRY_ENDPOINT_PAYLOAD_BYTES, { endpoint: 'test_cycle' }, Buffer.byteLength(data))

    this.#requestTracker.send(request, data, options, (err, res, statusCode) => {
      distributionMetric(
        TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_MS,
        { endpoint: 'test_cycle' },
        Date.now() - startRequestTime
      )
      if (err) {
        incrementCountMetric(
          TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_ERRORS,
          { endpoint: 'test_cycle', statusCode, errorType: statusCode ? undefined : err.code }
        )
        incrementCountMetric(
          TELEMETRY_ENDPOINT_PAYLOAD_DROPPED,
          { endpoint: 'test_cycle', statusCode, errorType: statusCode ? undefined : err.code }
        )
        log.error('Error sending CI agentless payload', err)
        done(err)
        return
      }
      log.debug('Response from the intake:', res)
      done()
    })
  }

  addMetadataTags (tags) {
    this._encoder.addMetadataTags(tags)
  }
}

module.exports = Writer
