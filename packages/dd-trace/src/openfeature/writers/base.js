'use strict'

const request = require('../../exporters/common/request')
const { safeJSONStringify } = require('../../exporters/common/util')
const { URL, format } = require('node:url')

const log = require('../../log')

/**
 * @typedef {Object} BaseFFEWriterOptions
 * @property {number} [interval] - Flush interval in milliseconds
 * @property {number} [timeout] - Request timeout in milliseconds
 * @property {Object} config - Tracer configuration object
 * @property {string} endpoint - API endpoint path
 * @property {URL} [agentUrl] - Base URL for the agent
 * @property {number} [payloadSizeLimit] - Maximum payload size in bytes
 * @property {number} [eventSizeLimit] - Maximum individual event size in bytes
 * @property {Object} [headers] - Additional HTTP headers
 */

/**
 * BaseFFEWriter is the base class for sending Feature Flagging & Exposure Events payloads to the Datadog Agent.
 * @class BaseFFEWriter
 */
class BaseFFEWriter {
  /**
   * @param {BaseFFEWriterOptions} options - Writer configuration options
   */
  constructor ({ interval, timeout, config, endpoint, agentUrl, payloadSizeLimit, eventSizeLimit, headers }) {
    this._interval = interval ?? 1000
    this._timeout = timeout ?? 5000

    this._buffer = []
    this._bufferLimit = 1000
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

  /**
   * Appends an event array to the buffer
   * @param {Array|Object} events - Event object(s) to append to buffer
   */
  append (events) {
    const eventArray = Array.isArray(events) ? events : [events]

    for (const event of eventArray) {
      if (this._buffer.length >= this._bufferLimit) {
        log.warn(`${this.constructor.name} event buffer full (limit is ${this._bufferLimit}), dropping event`)
        this._droppedEvents++
        continue
      }

      const eventSizeBytes = Buffer.byteLength(JSON.stringify(event))

      // Check individual event size limit if configured
      if (this._eventSizeLimit && eventSizeBytes > this._eventSizeLimit) {
        log.warn(`${this.constructor.name} event size
          ${eventSizeBytes} bytes exceeds limit ${this._eventSizeLimit}, dropping event`)
        this._droppedEvents++
        continue
      }

      // Check if adding this event would exceed payload size limit if configured
      if (this._payloadSizeLimit && this._bufferSize + eventSizeBytes > this._payloadSizeLimit) {
        log.debug(`${this.constructor.name} buffer size would exceed ${this._payloadSizeLimit} bytes, flushing first`)
        this.flush()
      }

      this._bufferSize += eventSizeBytes
      this._buffer.push(event)
    }
  }

  /**
   * Flushes all buffered events to the agent
   */
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
        log.error(`Failed to send events to ${this._baseUrl.href}${this._endpoint}: ${err.message}`)
      } else if (code >= 200 && code < 300) {
        log.debug(`Successfully sent ${events.length} events`)
      } else {
        log.warn(`Events request returned status ${code}`)
      }
    })
  }

  /**
   * Override in subclass to customize payload structure
   * @param {Array} events - Array of events to be sent
   * @returns {object} Formatted payload
   */
  makePayload (events) {
    // Override in subclass
    return events
  }

  /**
   * Cleans up resources and flushes remaining events
   */
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

  /**
   * @private
   * @returns {URL} Constructs agent URL from config
   */
  _getAgentUrl () {
    const { hostname, port } = this._config

    return this._config.url ?? new URL(format({
      protocol: 'http:',
      hostname: hostname || 'localhost',
      port: port || 8126
    }))
  }

  /**
   * @private
   * @returns {Object} constructs HTTP request options
   */
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

  /**
   * @private
   * @param {Array<object>} payload - Payload to encode
   * @returns {string} JSON-stringified payload
   */
  _encode (payload) {
    return JSON.stringify(payload)
  }
}

module.exports = BaseFFEWriter
