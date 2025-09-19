'use strict'

const request = require('../../exporters/common/request')
const { safeJSONStringify } = require('../../exporters/common/util')
const { getEnvironmentVariable } = require('../../config-helper')
const { URL, format } = require('node:url')
const path = require('node:path')

const log = require('../../log')

const {
  EVP_SUBDOMAIN_HEADER_NAME,
  EVP_SUBDOMAIN_VALUE,
  EVP_PROXY_AGENT_BASE_PATH,
  EVP_PAYLOAD_SIZE_LIMIT,
  EVP_EVENT_SIZE_LIMIT
} = require('../constants/writers')

class BaseFFEWriter {
  constructor ({ interval, timeout, config, endpoint }) {
    this._interval = interval ?? getEnvironmentVariable('_DD_FFE_FLUSH_INTERVAL') ?? 1000 // 1s
    this._timeout = timeout ?? getEnvironmentVariable('_DD_FFE_TIMEOUT') ?? 5000 // 5s

    this._buffer = []
    this._bufferLimit = 1000 // Max events per batch
    this._bufferSize = 0

    this._config = config
    this._endpoint = endpoint

    // FFE only works with agent EVP proxy, agentless is not supported
    const { url, endpoint: fullEndpoint } = this._getAgentUrlAndPath()
    this._baseUrl = url
    this._endpoint = fullEndpoint

    this._periodic = setInterval(() => {
      this.flush()
    }, this._interval).unref()

    this._beforeExitHandler = () => {
      this.destroy()
    }
    process.once('beforeExit', this._beforeExitHandler)

    this._destroyed = false
    this._droppedEvents = 0
  }

  get url () {
    const baseUrl = this._baseUrl.href
    const endpoint = this._endpoint

    // Split on protocol separator to preserve it
    const [protocol, rest] = baseUrl.split('://')
    return protocol + '://' + path.join(rest, endpoint)
  }

  append (event, byteLength) {
    if (this._buffer.length >= this._bufferLimit) {
      log.warn(`${this.constructor.name} event buffer full (limit is ${this._bufferLimit}), dropping event`)
      this._droppedEvents++
      return
    }

    const eventSizeBytes = byteLength || Buffer.byteLength(JSON.stringify(event))

    // Check individual event size limit (1MB)
    if (eventSizeBytes > EVP_EVENT_SIZE_LIMIT) {
      log.warn(`${this.constructor.name} event size ${eventSizeBytes}
        bytes exceeds limit ${EVP_EVENT_SIZE_LIMIT}, dropping event`)
      this._droppedEvents++
      return
    }

    // Check if adding this event would exceed payload size limit (5MB)
    if (this._bufferSize + eventSizeBytes > EVP_PAYLOAD_SIZE_LIMIT) {
      log.debug(`${this.constructor.name} buffer size would exceed ${EVP_PAYLOAD_SIZE_LIMIT} bytes, flushing first`)
      this.flush()
    }

    this._bufferSize += eventSizeBytes
    this._buffer.push(event)
  }

  flush () {
    if (this._buffer.length === 0) {
      return
    }
    const events = this._buffer
    this._buffer = []
    this._bufferSize = 0

    const payload = this._encode(this.makePayload(events))

    log.debug('Encoded FFE exposure payload: %s', safeJSONStringify(payload))

    const options = this._getOptions()

    request(payload, options, (err, resp, code) => {
      if (err) {
        log.error(`Failed to send FFE exposure events to ${this.url}: ${err.message}`)
      } else if (code >= 200 && code < 300) {
        log.debug(`Successfully sent ${events.length} FFE exposure events`)
      } else {
        log.warn(`FFE exposure events request returned status ${code}`)
      }
    })
  }

  makePayload (events) {
    // Override in subclass
    return events
  }

  destroy () {
    if (!this._destroyed) {
      log.debug(`Stopping ${this.constructor.name}`)
      clearInterval(this._periodic)
      process.removeListener('beforeExit', this._beforeExitHandler)
      this.flush()
      this._destroyed = true

      if (this._droppedEvents > 0) {
        log.warn(`${this.constructor.name} dropped ${this._droppedEvents} events due to buffer overflow`)
      }
    }
  }

  _getAgentUrlAndPath () {
    const { hostname, port } = this._config

    const overrideOriginEnv = getEnvironmentVariable('_DD_FFE_OVERRIDE_ORIGIN')
    const overrideOriginUrl = overrideOriginEnv && new URL(overrideOriginEnv)

    const base = overrideOriginUrl ?? this._config.url ?? new URL(format({
      protocol: 'http:',
      hostname: hostname || 'localhost',
      port: port || 8126
    }))

    return {
      url: base,
      endpoint: path.join(EVP_PROXY_AGENT_BASE_PATH + '/', this._endpoint)
    }
  }

  _getOptions () {
    const options = {
      headers: {
        'Content-Type': 'application/json',
        [EVP_SUBDOMAIN_HEADER_NAME]: EVP_SUBDOMAIN_VALUE
      },
      method: 'POST',
      timeout: this._timeout,
      url: this._baseUrl,
      path: this._endpoint
    }

    return options
  }

  // Handle any special encoding logic for FFE based on requirements
  _encode (payload) {
    return JSON.stringify(payload, (key, value) => {
      if (typeof value === 'string') {
        return value
      }
      return value
    })
  }
}

module.exports = BaseFFEWriter
