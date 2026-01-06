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

class BaseLLMObsWriter {
  #destroyer
  #buffers = new Map()
  #originalEndpoint

  constructor ({ interval, timeout, eventType, config, endpoint, intake }) {
    this._interval = interval ?? getEnvironmentVariable('_DD_LLMOBS_FLUSH_INTERVAL') ?? 1000 // 1s
    this._timeout = timeout ?? getEnvironmentVariable('_DD_LLMOBS_TIMEOUT') ?? 5000 // 5s
    this._eventType = eventType

    this._bufferLimit = 1000

    this._config = config
    this.#originalEndpoint = endpoint
    this._endpoint = endpoint
    this._intake = intake

    this._periodic = setInterval(() => {
      this.flush()
    }, this._interval).unref()

    const destroyer = this.destroy.bind(this)
    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(destroyer)

    this.#destroyer = destroyer
  }

  get url () {
    if (this._agentless == null) return null

    const baseUrl = this._baseUrl.href
    const endpoint = this._endpoint

    // Split on protocol separator to preserve it
    // path.join will remove some slashes unnecessarily
    const [protocol, rest] = baseUrl.split('://')
    return protocol + '://' + path.join(rest, endpoint)
  }

  get _buffer () {
    const defaultKey = this._getRoutingKey()
    const buffer = this.#buffers.get(defaultKey)
    return buffer?.events || []
  }

  set _buffer (events) {
    const defaultKey = this._getRoutingKey()
    const buffer = this._getOrCreateBuffer(defaultKey)
    buffer.events = events
  }

  get _bufferSize () {
    const defaultKey = this._getRoutingKey()
    const buffer = this.#buffers.get(defaultKey)
    return buffer?.size || 0
  }

  set _bufferSize (size) {
    const defaultKey = this._getRoutingKey()
    const buffer = this._getOrCreateBuffer(defaultKey)
    buffer.size = size
  }

  _getRoutingKey (routing) {
    const apiKey = routing?.apiKey || this._config.apiKey || ''
    const site = routing?.site || this._config.site || ''
    return `${apiKey}:${site}`
  }

  #getMaskedRoutingKey (routing) {
    const apiKey = routing?.apiKey || this._config.apiKey || ''
    const site = routing?.site || this._config.site || ''
    const maskedKey = apiKey ? `****${apiKey.slice(-4)}` : ''
    return `${maskedKey}:${site}`
  }

  _getOrCreateBuffer (routingKey, routing) {
    if (!this.#buffers.has(routingKey)) {
      this.#buffers.set(routingKey, {
        events: [],
        size: 0,
        routing: {
          apiKey: routing?.apiKey || this._config.apiKey,
          site: routing?.site || this._config.site
        }
      })
    }
    return this.#buffers.get(routingKey)
  }

  append (event, routing, byteLength) {
    const routingKey = this._getRoutingKey(routing)
    const buffer = this._getOrCreateBuffer(routingKey, routing)

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
    const noAgentStrategy = this._agentless == null

    if (noAgentStrategy) {
      return
    }

    for (const [, buffer] of this.#buffers) {
      if (buffer.events.length === 0) continue

      const events = buffer.events
      buffer.events = []
      buffer.size = 0

      const payload = this._encode(this.makePayload(events))
      const options = this._getOptions(buffer.routing)
      const url = this.#getUrlForRouting(buffer.routing)

      log.debug('Encoded LLMObs payload for %s: %s', this.#getMaskedRoutingKey(buffer.routing), payload)

      request(payload, options, (err, resp, code) => {
        parseResponseAndLog(err, code, events.length, url, this._eventType)
      })
    }

    this.#cleanupEmptyBuffers()
  }

  #cleanupEmptyBuffers () {
    for (const [key, buffer] of this.#buffers) {
      if (buffer.events.length === 0) {
        this.#buffers.delete(key)
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
        endpoint: this.#originalEndpoint
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
      endpoint: path.join(EVP_PROXY_AGENT_BASE_PATH, this.#originalEndpoint)
    }
  }

  #getUrlForRouting (routing) {
    const { url, endpoint } = this._getUrlAndPath(routing)
    const [protocol, rest] = url.href.split('://')
    return protocol + '://' + path.join(rest, endpoint)
  }

  _getOptions (routing) {
    const { url, endpoint } = this._getUrlAndPath(routing)

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
