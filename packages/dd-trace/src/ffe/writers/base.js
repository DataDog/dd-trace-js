'use strict'

const request = require('../../exporters/common/request')
const { safeJSONStringify } = require('../../exporters/common/util')
const { getEnvironmentVariable } = require('../../config-helper')
const { URL, format } = require('node:url')
const path = require('node:path')

const log = require('../../log')

class BaseFFEWriter {
  constructor ({ interval, timeout, config, endpoint, agentUrl, payloadSizeLimit, eventSizeLimit, headers }) {
    // Private env vars for testing purposes
    this._interval = interval ?? Number.parseInt(getEnvironmentVariable('_DD_FFE_FLUSH_INTERVAL')) ?? 1000 // 1s
    this._timeout = timeout ?? Number.parseInt(getEnvironmentVariable('_DD_FFE_TIMEOUT')) ?? 5000 // 5s

    this._buffer = []
    this._bufferLimit = 1000 // Max events per batch
    this._bufferSize = 0

    this._config = config
    this._endpoint = endpoint
    this._baseUrl = agentUrl ?? this._getAgentUrl()
    this._payloadSizeLimit = payloadSizeLimit
    this._eventSizeLimit = eventSizeLimit
    this._headers = headers || {}

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

    // Check individual event size limit if configured
    if (this._eventSizeLimit && eventSizeBytes > this._eventSizeLimit) {
      log.warn(`${this.constructor.name} event size
        ${eventSizeBytes} bytes exceeds limit ${this._eventSizeLimit}, dropping event`)
      this._droppedEvents++
      return
    }

    // Check if adding this event would exceed payload size limit if configured
    if (this._payloadSizeLimit && this._bufferSize + eventSizeBytes > this._payloadSizeLimit) {
      log.debug(`${this.constructor.name} buffer size would exceed ${this._payloadSizeLimit} bytes, flushing first`)
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

    log.debug('Encoded payload: %s', safeJSONStringify(payload))

    const options = this._getOptions()

    request(payload, options, (err, resp, code) => {
      if (err) {
        log.error(`Failed to send events to ${this.url}: ${err.message}`)
      } else if (code >= 200 && code < 300) {
        log.debug(`Successfully sent ${events.length} events`)
      } else {
        log.warn(`Events request returned status ${code}`)
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

  _getAgentUrl () {
    const { hostname, port } = this._config

    const overrideOriginEnv = getEnvironmentVariable('_DD_FFE_OVERRIDE_ORIGIN')
    const overrideOriginUrl = overrideOriginEnv && new URL(overrideOriginEnv)

    return overrideOriginUrl ?? this._config.url ?? new URL(format({
      protocol: 'http:',
      hostname: hostname || 'localhost',
      port: port || 8126
    }))
  }

  _getOptions () {
    const options = {
      headers: {
        'Content-Type': 'application/json',
        ...this._headers
      },
      method: 'POST',
      timeout: this._timeout,
      url: this._baseUrl,
      path: this._endpoint
    }

    return options
  }

  _encode (payload) {
    return JSON.stringify(payload)
  }
}

module.exports = BaseFFEWriter
