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
  _buffer = []
  _bufferSize = 0
  #multiTenantBuffers = new Map()
  #endpoint

  constructor ({ interval, timeout, eventType, config, endpoint, intake }) {
    this._interval = interval ?? getEnvironmentVariable('_DD_LLMOBS_FLUSH_INTERVAL') ?? 1000 // 1s
    this._timeout = timeout ?? getEnvironmentVariable('_DD_LLMOBS_TIMEOUT') ?? 5000 // 5s
    this._eventType = eventType

    this._bufferLimit = 1000

    this._config = config
    this.#endpoint = endpoint
    this._intake = intake

    this._periodic = setInterval(() => {
      this.flush()
    }, this._interval).unref()

    const destroyer = this.destroy.bind(this)
    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(destroyer)

    this.#destroyer = destroyer
  }

  #getUrlForRouting (routing) {
    const { url, endpoint } = this._getUrlAndPath(routing)
    const [protocol, rest] = url.href.split('://')
    return protocol + '://' + path.join(rest, endpoint)
  }

  get url () {
    if (this._agentless == null) return null
    const { url, endpoint } = this._getUrlAndPath()
    const [protocol, rest] = url.href.split('://')
    return protocol + '://' + path.join(rest, endpoint)
  }

  #getMultiTenantRoutingKey (routing) {
    const apiKey = routing?.apiKey || ''
    const site = routing?.site || ''
    return `${apiKey}:${site}`
  }

  #getOrCreateMultiTenantBuffer (routingKey, routing) {
    if (!this.#multiTenantBuffers.has(routingKey)) {
      this.#multiTenantBuffers.set(routingKey, {
        events: [],
        size: 0,
        routing: {
          apiKey: routing?.apiKey,
          site: routing?.site
        }
      })
    }
    return this.#multiTenantBuffers.get(routingKey)
  }

  append (event, routing, byteLength) {
    const eventSize = byteLength || Buffer.byteLength(JSON.stringify(event))

    if (routing) {
      const routingKey = this.#getMultiTenantRoutingKey(routing)
      const buffer = this.#getOrCreateMultiTenantBuffer(routingKey, routing)

      if (buffer.events.length >= this._bufferLimit) {
        logger.warn(`${this.constructor.name} event buffer full (limit is ${this._bufferLimit}), dropping event`)
        telemetry.recordDroppedPayload(1, this._eventType, 'buffer_full')
        return
      }

      buffer.size += eventSize
      buffer.events.push(event)
    } else {
      if (this._buffer.length >= this._bufferLimit) {
        logger.warn(`${this.constructor.name} event buffer full (limit is ${this._bufferLimit}), dropping event`)
        telemetry.recordDroppedPayload(1, this._eventType, 'buffer_full')
        return
      }

      this._bufferSize += eventSize
      this._buffer.push(event)
    }
  }

  flush () {
    if (this._agentless == null) {
      return
    }

    if (this._buffer.length > 0) {
      const events = this._buffer
      this._buffer = []
      this._bufferSize = 0

      const payload = this._encode(this.makePayload(events))
      const options = this._getOptions()
      const url = this.url

      log.debug('Encoded LLMObs payload: %s', payload)

      request(payload, options, (err, resp, code) => {
        parseResponseAndLog(err, code, events.length, url, this._eventType)
      })
    }

    for (const [, buffer] of this.#multiTenantBuffers) {
      if (buffer.events.length === 0) continue

      const events = buffer.events
      buffer.events = []
      buffer.size = 0

      const payload = this._encode(this.makePayload(events))
      const options = this._getOptions(buffer.routing)
      const url = this.#getUrlForRouting(buffer.routing)
      const site = buffer.routing?.site || ''
      const maskedApiKey = buffer.routing?.apiKey ? `****${buffer.routing.apiKey.slice(-4)}` : ''

      log.debug('Encoding and flushing multi-tenant buffer for %s with %s', site, maskedApiKey)

      request(payload, options, (err, resp, code) => {
        parseResponseAndLog(err, code, events.length, url, this._eventType)
      })
    }

    this.#cleanupEmptyBuffers()
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
        endpoint: this.#endpoint
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
      endpoint: path.join(EVP_PROXY_AGENT_BASE_PATH, this.#endpoint)
    }
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
