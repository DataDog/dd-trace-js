'use strict'

const request = require('../../exporters/common/request')
const { safeJSONStringify } = require('../../exporters/common/util')
const { getAgentUrl } = require('../../agent/url')

const log = require('../../log')

/**
 * @typedef {object} BaseFFEWriterOptions
 * @property {number} [interval] - Flush interval in milliseconds
 * @property {number} [timeout] - Request timeout in milliseconds
 * @property {object} config - Tracer configuration object
 * @property {string} endpoint - API endpoint path
 * @property {URL} [agentUrl] - Base URL for the agent
 * @property {number} [payloadSizeLimit] - Maximum payload size in bytes
 * @property {number} [eventSizeLimit] - Maximum individual event size in bytes
 * @property {object} [headers] - Additional HTTP headers
 */

/**
 * BaseFFEWriter is the base class for sending Feature Flagging & Exposure Events payloads to the Datadog Agent.
 * @class BaseFFEWriter
 */
class BaseFFEWriter {
  #destroyer
  #interval
  #timeout
  #buffer
  #bufferLimit
  #bufferSize
  #endpoint
  #baseUrl
  #payloadSizeLimit
  #eventSizeLimit
  #headers
  #requestOptions
  #periodic
  #droppedEvents

  /**
   * @param {BaseFFEWriterOptions} options - Writer configuration options
   */
  constructor ({ interval, timeout, config, endpoint, agentUrl, payloadSizeLimit, eventSizeLimit, headers }) {
    this.#interval = interval ?? 1000
    this.#timeout = timeout ?? 5000

    this.#buffer = []
    this.#bufferLimit = 1000
    this.#bufferSize = 0

    this._config = config
    this.#endpoint = endpoint
    this.#baseUrl = agentUrl ?? this._getAgentUrl()
    this.#payloadSizeLimit = payloadSizeLimit
    this.#eventSizeLimit = eventSizeLimit
    this.#headers = headers || {}

    this.#requestOptions = {
      headers: {
        ...this.#headers,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      timeout: this.#timeout,
      url: this.#baseUrl,
      path: this.#endpoint,
    }

    this.#periodic = setInterval(() => {
      this.flush()
    }, this.#interval).unref()

    const destroyer = this.destroy.bind(this)
    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(destroyer)

    this.#destroyer = destroyer
    this.#droppedEvents = 0
  }

  /**
   * Appends an event array to the buffer
   * @param {Array | object} events - Event object(s) to append to buffer
   */
  append (events) {
    const eventArray = Array.isArray(events) ? events : [events]

    for (const event of eventArray) {
      if (this.#buffer.length >= this.#bufferLimit) {
        log.warn('%s event buffer full (limit is %d), dropping event', this.constructor.name, this.#bufferLimit)
        this.#droppedEvents++
        continue
      }

      const eventSizeBytes = Buffer.byteLength(JSON.stringify(event))

      // Check individual event size limit if configured
      if (this.#eventSizeLimit && eventSizeBytes > this.#eventSizeLimit) {
        log.warn('%s event size %d bytes exceeds limit %d, dropping event',
          this.constructor.name, eventSizeBytes, this.#eventSizeLimit)
        this.#droppedEvents++
        continue
      }

      // Check if adding this event would exceed payload size limit if configured
      if (this.#payloadSizeLimit && this.#bufferSize + eventSizeBytes > this.#payloadSizeLimit) {
        log.debug('%s buffer size would exceed %d bytes, flushing first', this.constructor.name, this.#payloadSizeLimit)
        this.flush()
      }

      this.#bufferSize += eventSizeBytes
      this.#buffer.push(event)
    }
  }

  /**
   * Flushes all buffered events to the agent
   */
  flush () {
    if (this.#buffer.length === 0) {
      return
    }
    const events = this.#buffer
    this.#buffer = []
    this.#bufferSize = 0

    const payload = this._encode(this.makePayload(events))

    // eslint-disable-next-line eslint-rules/eslint-log-printf-style
    log.debug(() => `${this.constructor.name} flushing payload: ${safeJSONStringify(payload)}`)

    request(payload, this.#requestOptions, (err, resp, code) => {
      if (err) {
        log.error('Failed to send events to %s%s', this.#baseUrl.href, this.#endpoint, err)
      } else if (code >= 200 && code < 300) {
        log.debug('Successfully sent %d events', events.length)
      } else {
        log.warn('Events request returned status %d', code)
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
    if (this.#destroyer) {
      log.debug('Stopping %s', this.constructor.name)
      clearInterval(this.#periodic)
      this.flush()
      globalThis[Symbol.for('dd-trace')].beforeExitHandlers.delete(this.#destroyer)
      this.#destroyer = undefined

      if (this.#droppedEvents > 0) {
        log.warn('%s dropped %d events due to buffer overflow', this.constructor.name, this.#droppedEvents)
      }
    }
  }

  // TODO: Refactor all of these getters to use proxyquire or sinon
  // Exposed for test access
  get _interval () { return this.#interval }

  // Exposed for test access
  get _timeout () { return this.#timeout }

  // Exposed for test access
  get _buffer () { return this.#buffer }

  // Exposed for test access
  get _bufferSize () { return this.#bufferSize }

  // Exposed for test access
  get _bufferLimit () { return this.#bufferLimit }

  // Exposed for test access
  set _bufferLimit (value) { this.#bufferLimit = value }

  // Exposed for test access
  get _periodic () { return this.#periodic }

  // Exposed for test access
  get _droppedEvents () { return this.#droppedEvents }

  // Exposed for test access
  set _droppedEvents (value) { this.#droppedEvents = value }

  /**
   * @private
   * @returns {URL} Constructs agent URL from config
   */
  _getAgentUrl () {
    return getAgentUrl(this._config)
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
