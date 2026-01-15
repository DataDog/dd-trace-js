'use strict'

const { URL, format } = require('node:url')
const path = require('node:path')
const request = require('../../exporters/common/request')
const { getEnvironmentVariable } = require('../../config/helper')

const logger = require('../../log')

const { encodeUnicode } = require('../util')
const telemetry = require('../telemetry')
const log = require('../../log')
const {
  EVP_SUBDOMAIN_HEADER_NAME,
  EVP_PROXY_AGENT_BASE_PATH
} = require('../constants/writers')
const { parseResponseAndLog } = require('./util')

class LLMObsBuffer {
  constructor ({ events, size, routing, isDefault }) {
    this.events = events
    this.size = size
    this.routing = routing ?? {}
    this.isDefault = isDefault ?? false
  }
}

class BaseLLMObsWriter {
  #destroyer
  #multiTenantBuffers = new Map()
  #routingContextAgentModeWarned = false

  constructor ({ interval, timeout, eventType, config, endpoint, intake }) {
    this._interval = interval ?? getEnvironmentVariable('_DD_LLMOBS_FLUSH_INTERVAL') ?? 1000 // 1s
    this._timeout = timeout ?? getEnvironmentVariable('_DD_LLMOBS_TIMEOUT') ?? 5000 // 5s
    this._eventType = eventType

    this._buffer = new LLMObsBuffer({ events: [], size: 0, isDefault: true })
    this._bufferLimit = 1000

    this._config = config
    this._endpoint = endpoint
    this._intake = intake

    this._periodic = setInterval(() => {
      this.flush()
    }, this._interval).unref()

    const destroyer = this.destroy.bind(this)
    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(destroyer)

    this.#destroyer = destroyer
  }

  // Split on protocol separator to preserve it
  // path.join will remove some slashes unnecessarily
  #buildUrl (baseUrl, endpoint) {
    const [protocol, rest] = baseUrl.split('://')
    return protocol + '://' + path.join(rest, endpoint)
  }

  get url () {
    if (this._agentless == null) return null
    return this.#buildUrl(this._baseUrl.href, this._endpoint)
  }

  _getBuffer (routing) {
    if (!routing?.apiKey) {
      return this._buffer
    }
    const apiKey = routing.apiKey
    let buffer = this.#multiTenantBuffers.get(apiKey)
    if (!buffer) {
      buffer = new LLMObsBuffer({ events: [], size: 0, routing })
      this.#multiTenantBuffers.set(apiKey, buffer)
    }
    return buffer
  }

  append (event, routing, byteLength) {
    if (routing?.apiKey && this._agentless === false && !this.#routingContextAgentModeWarned) {
      this.#routingContextAgentModeWarned = true
      logger.warn(
        '[LLM Observability] Routing context is only supported in agentless mode. ' +
        'Spans will be sent to the configured agent org.'
      )
    }
    const buffer = this._getBuffer(routing)

    if (buffer.events.length >= this._bufferLimit) {
      logger.warn(`${this.constructor.name} event buffer full (limit is ${this._bufferLimit}), dropping event`)
      telemetry.recordDroppedPayload(1, this._eventType, 'buffer_full')
      return
    }

    const eventSize = byteLength || Buffer.byteLength(JSON.stringify(event))

    buffer.size += eventSize
    buffer.events.push(event)
  }

  flush () {
    if (this._agentless == null) {
      return
    }

    // Flush default buffer
    if (this._buffer.events.length > 0) {
      const events = this._buffer.events
      this._buffer.events = []
      this._buffer.size = 0

      const payload = this._encode(this.makePayload(events))

      log.debug('Encoded LLMObs payload: %s', payload)

      const options = this._getOptions()

      request(payload, options, (err, resp, code) => {
        parseResponseAndLog(err, code, events.length, this.url, this._eventType)
      })
    }

    // Flush multi-tenant buffers
    for (const [apiKey, buffer] of this.#multiTenantBuffers) {
      if (buffer.events.length === 0) continue

      const events = buffer.events
      buffer.events = []
      buffer.size = 0

      const payload = this._encode(this.makePayload(events))
      const options = this._agentless ? this._getOptions(buffer.routing) : this._getOptions()
      const url = this._agentless ? this.#getUrlForRouting(buffer.routing) : this.url
      const maskedApiKey = apiKey ? `****${apiKey.slice(-4)}` : ''

      log.debug('Encoding and flushing multi-tenant buffer for %s', maskedApiKey)
      log.debug('Encoded LLMObs payload: %s', payload)

      request(payload, options, (err, resp, code) => {
        parseResponseAndLog(err, code, events.length, url, this._eventType)
      })
    }

    this.#cleanupEmptyBuffers()
  }

  #getUrlForRouting (routing) {
    const { url, endpoint } = this._getUrlAndPath(routing)
    return this.#buildUrl(url.href, endpoint)
  }

  #cleanupEmptyBuffers () {
    for (const [key, buffer] of this.#multiTenantBuffers) {
      if (buffer.events.length === 0) {
        this.#multiTenantBuffers.delete(key)
      }
    }
  }

  makePayload (events) {}

  destroy () {
    if (this.#destroyer) {
      logger.debug(`Stopping ${this.constructor.name}`)
      clearInterval(this._periodic)
      globalThis[Symbol.for('dd-trace')].beforeExitHandlers.delete(this.#destroyer)
      this.flush()
      this.#destroyer = undefined
    }
  }

  setAgentless (agentless) {
    this._agentless = agentless
    const { url, endpoint } = this._getUrlAndPath()

    this._baseUrl = url
    this._endpoint = endpoint

    logger.debug(`Configuring ${this.constructor.name} to ${this.url}`)
  }

  _getUrlAndPath (routing) {
    if (this._agentless) {
      const site = routing?.site || this._config.site
      return {
        url: new URL(format({
          protocol: 'https:',
          hostname: `${this._intake}.${site}`
        })),
        endpoint: this._endpoint
      }
    }

    const { hostname, port } = this._config

    const overrideOriginEnv = getEnvironmentVariable('_DD_LLMOBS_OVERRIDE_ORIGIN')
    const overrideOriginUrl = overrideOriginEnv && new URL(overrideOriginEnv)

    const base = overrideOriginUrl ?? this._config.url ?? new URL(format({
      protocol: 'http:',
      hostname,
      port
    }))

    return {
      url: base,
      endpoint: path.join(EVP_PROXY_AGENT_BASE_PATH, this._endpoint)
    }
  }

  _getOptions (routing) {
    const useRouting = this._agentless && routing
    const { url, endpoint } = useRouting
      ? this._getUrlAndPath(routing)
      : { url: this._baseUrl, endpoint: this._endpoint }

    const options = {
      headers: {
        'Content-Type': 'application/json'
      },
      method: 'POST',
      timeout: this._timeout,
      url,
      path: endpoint
    }

    if (this._agentless) {
      options.headers['DD-API-KEY'] = routing?.apiKey || this._config.apiKey || ''
    } else {
      options.headers[EVP_SUBDOMAIN_HEADER_NAME] = this._intake
    }

    return options
  }

  _encode (payload) {
    return JSON.stringify(payload, (key, value) => {
      if (typeof value === 'string') {
        return encodeUnicode(value) // serialize unicode characters
      }
      return value
    }).replaceAll(String.raw`\\u`, String.raw`\u`) // remove double escaping
  }
}

module.exports = BaseLLMObsWriter
