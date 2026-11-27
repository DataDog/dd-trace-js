'use strict'

const { FLAG_EVALUATION_ENDPOINT, EVP_EVENT_SIZE_LIMIT, EVP_PAYLOAD_SIZE_LIMIT } = require('../constants/constants')
const { EVP_PROXY_PATH_V2, EVP_EVENT_PLATFORM_SUBDOMAIN, EVP_SUBDOMAIN_HEADER_NAME } =
  require('../../evp_proxy/constants')
const { joinEVPProxyPath } = require('../../evp_proxy/path')
const BaseFFEWriter = require('./base')
const { setEventDeliveryStrategy } = require('./util')

const MAX_PENDING_DIAGNOSTICS = 16
// Leave room for delivery before intake's 24-hour timestamp limit.
const MAX_QUEUE_AGE_MS = 60 * 60 * 1000

class SDKDiagnosticsWriter extends BaseFFEWriter {
  #enabled = false
  #closed = false
  #stopDeliveryStrategy

  /** @param {import('../../config/config-base')} config */
  constructor (config) {
    super({
      config,
      endpoint: joinEVPProxyPath(EVP_PROXY_PATH_V2, FLAG_EVALUATION_ENDPOINT),
      payloadSizeLimit: EVP_PAYLOAD_SIZE_LIMIT,
      eventSizeLimit: EVP_EVENT_SIZE_LIMIT,
      // Transport errors can contain credentials or response bodies.
      formatError: (error, status) => status === undefined
        ? /** @type {{code?: string}} */ (error).code ?? 'UNKNOWN'
        : 'none',
    })
    this._bufferLimit = MAX_PENDING_DIAGNOSTICS
    try {
      this.#stopDeliveryStrategy = setEventDeliveryStrategy(config, (enabled, route) => {
        if (this.#closed) return
        this.#enabled = enabled
        if (route) this._setRoutes(this.#route(route), route.fallback && this.#route(route.fallback))
      })
    } catch (error) {
      this.destroy()
      throw error
    }
  }

  /**
   * @param {import('./flag-evaluation-consumer').FlagEvaluationRoute} route
   * @returns {import('./base').WriterRoute}
   */
  #route (route) {
    return {
      ...route,
      endpoint: joinEVPProxyPath(route.basePath, FLAG_EVALUATION_ENDPOINT),
      headers: route.headers ?? { [EVP_SUBDOMAIN_HEADER_NAME]: EVP_EVENT_PLATFORM_SUBDOMAIN },
    }
  }

  /** @param {object} event */
  append (event) {
    if (!this.#closed) super.append(event)
  }

  flush () {
    // Route discovery or a prolonged outage must not retain stale diagnostics indefinitely.
    this._buffer = this._buffer.filter(event => Date.now() - event.payload.timestamp < MAX_QUEUE_AGE_MS)
    this._bufferSize = this._buffer.reduce((size, event) => size + Buffer.byteLength(JSON.stringify(event)), 0)
    if (this.#enabled) super.flush()
  }

  /** @param {object[]} diagnostics */
  makePayload (diagnostics) {
    return {
      context: { service: this._config.service, env: this._config.env, version: this._config.version },
      flagEvaluations: [],
      diagnostics,
    }
  }

  destroy () {
    if (this.#closed) return
    this.#closed = true
    super.destroy()
    this.#stopDeliveryStrategy?.()
    this._buffer = []
    this._bufferSize = 0
  }
}

module.exports = SDKDiagnosticsWriter
