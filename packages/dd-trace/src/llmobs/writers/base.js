'use strict'

const { URL, format } = require('node:url')
const path = require('node:path')
const request = require('../../exporters/common/request')
const { getEnvironmentVariable } = require('../../config/helper')
const { createServerlessDeliveryTracker } = require('../../serverless')

const logger = require('../../log')

const { encodeUnicode } = require('../util')
const telemetry = require('../telemetry')
const log = require('../../log')
const {
  EVP_SUBDOMAIN_HEADER_NAME,
  EVP_PROXY_AGENT_BASE_PATH,
} = require('../constants/writers')
const { parseResponseAndLog } = require('./util')

class LLMObsBuffer {
  constructor ({ events, size, routing = {}, isDefault = false, limit = 1000 }) {
    this.events = events
    this.size = size
    this.routing = routing
    this.isDefault = isDefault
    this.limit = limit
  }

  clear () {
    this.events = []
    this.size = 0
  }
}

class BaseLLMObsWriter {
  #destroyer
  /** @type {Function[]} */
  #pendingFlushes = []
  #serverlessDeliveryTracker = createServerlessDeliveryTracker()
  /** @type {Map<string, LLMObsBuffer>} */
  #multiTenantBuffers = new Map()

  constructor ({ interval, timeout, eventType, config, endpoint, intake }) {
    this._interval = interval ?? getEnvironmentVariable('_DD_LLMOBS_FLUSH_INTERVAL') ?? 1000 // 1s
    this._timeout = timeout ?? getEnvironmentVariable('_DD_LLMOBS_TIMEOUT') ?? 5000 // 5s
    this._eventType = eventType

    /** @type {LLMObsBuffer} */
    this._buffer = new LLMObsBuffer({ events: [], size: 0, isDefault: true })

    /** @type {import('../../config/config-base')} */
    this._config = config

    this._endpoint = endpoint
    this._baseEndpoint = endpoint // should not be unset
    this._intake = intake

    this._periodic = setInterval(() => {
      this.flush()
    }, this._interval)
    this._periodic.unref?.()

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

  /**
   * @param {Record<string, unknown>} event
   * @param {{ apiKey?: string, site?: string }} [routing]
   * @param {number} [byteLength]
   * @returns {boolean} `true` if the event was buffered, `false` if it was dropped
   * (e.g. the per-routing buffer was full). Callers that depend on the event
   * actually being submitted should check this value.
   */
  append (event, routing, byteLength) {
    const buffer = this._getBuffer(routing)

    if (buffer.events.length >= buffer.limit) {
      logger.warn(`${this.constructor.name} event buffer full (limit is ${buffer.limit}), dropping event`)
      telemetry.recordDroppedPayload(1, this._eventType, 'buffer_full')
      return false
    }

    const eventSize = byteLength || Buffer.byteLength(JSON.stringify(event))

    buffer.size += eventSize
    buffer.events.push(event)
    return true
  }

  /**
   * Drains buffered events and joins requests active at this flush boundary.
   * @param {Function} [done]
   */
  flush (done) {
    if (this._agentless == null) {
      if (done) this.#pendingFlushes.push(done)
      return
    }

    const requests = this.#drainBuffers()
    if (!this.#serverlessDeliveryTracker) {
      // Only invocation-retaining platforms need completion-aware delivery.
      for (const request of requests) this.#sendSafely(request)
      done?.()
      return
    }

    for (const request of requests) this.#sendSafely(request)
    this.#serverlessDeliveryTracker.waitForIdle(done)
  }

  #sendSafely (requestToSend) {
    try {
      if (this.#serverlessDeliveryTracker) {
        this.#serverlessDeliveryTracker.track(done => this.#send(requestToSend, done))
      } else {
        this.#send(requestToSend)
      }
    } catch (error) {
      logger.error('Failed to send LLMObs %s events: %s', this._eventType, error.message)
    }
  }

  #drainBuffers () {
    const requests = []
    if (this._buffer.events.length > 0) {
      const events = this._buffer.events
      this._buffer.clear()
      requests.push({ events, options: this._getOptions(), url: this.url })
    }

    for (const [apiKey, buffer] of this.#multiTenantBuffers) {
      if (buffer.events.length === 0) continue
      const site = buffer.routing.site || this._config.site
      const maskedApiKey = apiKey ? `****${apiKey.slice(-4)}` : ''
      let options
      let url
      try {
        options = {
          headers: {
            'Content-Type': 'application/json',
            'DD-API-KEY': apiKey,
          },
          method: 'POST',
          timeout: this._timeout,
          url: new URL(format({
            protocol: 'https:',
            hostname: `${this._intake}.${site}`,
          })),
          path: this._baseEndpoint,
        }
        url = this.#buildUrl(options.url.href, options.path)
      } catch (error) {
        buffer.clear()
        logger.error(
          'Failed to route LLMObs %s events for API key %s: %s',
          this._eventType,
          maskedApiKey,
          error.message
        )
        continue
      }

      const events = buffer.events
      buffer.clear()
      log.debug('Encoding and flushing multi-tenant buffer for %s', maskedApiKey)
      requests.push({ events, options, url })
    }

    this.#cleanupEmptyBuffers()
    return requests
  }

  #send ({ events, options, url }, done) {
    const payload = this._encode(this.makePayload(events))
    log.debug('Encoded LLMObs payload: %s', payload)
    request(payload, options, (err, resp, code) => {
      parseResponseAndLog(err, code, events.length, url, this._eventType)
      done?.()
    })
  }

  #cleanupEmptyBuffers () {
    for (const [key, buffer] of this.#multiTenantBuffers) {
      if (buffer.events.length === 0) {
        this.#multiTenantBuffers.delete(key)
      }
    }
  }

  makePayload (events) {}

  /**
   * Stops periodic flushing and drains buffered events.
   * @param {Function} [done] Called after queued and active deliveries complete.
   */
  destroy (done) {
    if (this.#destroyer) {
      logger.debug(`Stopping ${this.constructor.name}`)
      clearInterval(this._periodic)
      globalThis[Symbol.for('dd-trace')].beforeExitHandlers.delete(this.#destroyer)
      this.flush(done)
      this.#destroyer = undefined
    } else {
      done?.()
    }
  }

  setAgentless (agentless) {
    this._agentless = agentless
    const { url, endpoint } = this._getUrlAndPath()

    this._baseUrl = url
    this._endpoint = endpoint

    logger.debug(`Configuring ${this.constructor.name} to ${this.url}`)

    const pendingFlushes = this.#pendingFlushes
    this.#pendingFlushes = []
    for (const done of pendingFlushes) this.flush(done)
  }

  _getUrlAndPath () {
    if (this._agentless) {
      const site = this._config.site
      return {
        url: new URL(format({
          protocol: 'https:',
          hostname: `${this._intake}.${site}`,
        })),
        endpoint: this._endpoint,
      }
    }

    const overrideOriginEnv = getEnvironmentVariable('_DD_LLMOBS_OVERRIDE_ORIGIN')
    const overrideOriginUrl = overrideOriginEnv && new URL(overrideOriginEnv)
    const base = overrideOriginUrl ?? this._config.url

    return {
      url: base,
      endpoint: path.join(EVP_PROXY_AGENT_BASE_PATH, this._endpoint),
    }
  }

  _getOptions () {
    const options = {
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
      timeout: this._timeout,
      url: this._baseUrl,
      path: this._endpoint,
    }

    if (this._agentless) {
      options.headers['DD-API-KEY'] = this._config.DD_API_KEY || ''
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
