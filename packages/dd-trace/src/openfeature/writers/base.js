'use strict'

const request = require('../../exporters/common/request')
const { safeJSONStringify } = require('../../exporters/common/util')

const log = require('../../log')

/**
 * @typedef {object} BaseFFEWriterOptions
 * @property {number} [interval] - Flush interval in milliseconds
 * @property {number} [timeout] - Request timeout in milliseconds
 * @property {object} config - Tracer configuration object
 * @property {string} endpoint - API endpoint path
 * @property {URL} [agentUrl] - Initial delivery URL
 * @property {number} [payloadSizeLimit] - Maximum payload size in bytes
 * @property {number} [eventSizeLimit] - Maximum individual event size in bytes
 * @property {object} [headers] - Additional HTTP headers
 */

/**
 * @typedef {object} WriterRoute
 * @property {URL} url - Route base URL
 * @property {string} endpoint - Route endpoint
 * @property {object} headers - Route-specific headers
 * @property {import('node:https').Agent} [agent] - Optional HTTPS proxy agent
 */

/**
 * @typedef {object} ActiveWriterRoute
 * @property {URL} url - Route base URL
 * @property {string} endpoint - Route endpoint
 * @property {object} requestOptions - HTTP request options
 */

/**
 * Tests whether a local route definitively rejected an event batch.
 *
 * @param {Error | null} error - Request error
 * @param {number | undefined} statusCode - HTTP response status
 * @returns {boolean} Whether direct retry is safe
 */
function isDefinitiveRejection (error, statusCode) {
  return error?.code === 'EAI_AGAIN' || error?.code === 'ECONNREFUSED' ||
    error?.code === 'ENOENT' || error?.code === 'ENOTFOUND' ||
    statusCode === 403 || statusCode === 404 || statusCode === 405
}

/**
 * Tests whether a local route can have accepted an event batch before failing.
 *
 * @param {Error | null} error - Request error
 * @returns {boolean} Whether the delivery result is ambiguous
 */
function isAmbiguousNetworkFailure (error) {
  return error?.code === 'ECONNRESET' || error?.code === 'EPIPE' || error?.code === 'ETIMEDOUT'
}

/**
 * Base writer for Feature Flagging and Experimentation event delivery.
 * @class BaseFFEWriter
 */
class BaseFFEWriter {
  #destroyer
  /**
   * @param {BaseFFEWriterOptions} options - Writer configuration options
   */
  constructor ({ interval, timeout, config, endpoint, agentUrl, payloadSizeLimit, eventSizeLimit, headers }) {
    this._interval = interval ?? 1000
    this._timeout = timeout ?? 5000

    this._buffer = []
    this._bufferLimit = 1000
    this._bufferStart = 0
    this._dropWarningLogged = false

    this._config = config
    this._endpoint = endpoint
    this._baseUrl = agentUrl ?? config.url
    this._payloadSizeLimit = payloadSizeLimit
    this._eventSizeLimit = eventSizeLimit
    this._headers = headers || {}
    this._fallbackRoute = undefined

    this._requestOptions = {
      headers: {
        ...this._headers,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      retry: true,
      timeout: this._timeout,
      url: this._baseUrl,
      path: this._endpoint,
    }

    this._periodic = setInterval(() => {
      this.flush()
    }, this._interval)
    this._periodic.unref?.()

    const destroyer = this.destroy.bind(this)
    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(destroyer)

    this.#destroyer = destroyer
    this._droppedEvents = 0
  }

  /**
   * Appends an event array to the buffer
   * @param {Array | object} events - Event object(s) to append to buffer
   */
  append (events) {
    const eventArray = Array.isArray(events) ? events : [events]

    for (const event of eventArray) {
      if (this._buffer.length < this._bufferLimit) {
        this._buffer.push(event)
      } else {
        this._buffer[this._bufferStart] = event
        this._bufferStart = (this._bufferStart + 1) % this._bufferLimit
        this._droppedEvents++

        if (!this._dropWarningLogged) {
          this._dropWarningLogged = true
          log.warn(
            '%s dropped exposure event(s) at cap %d. This may invalidate experiment results.',
            this.constructor.name,
            this._bufferLimit
          )
        }
      }
    }
  }

  /**
   * Sizes, batches, and flushes all buffered events.
   */
  flush () {
    if (this._buffer.length === 0) {
      return
    }

    const events = this._bufferStart === 0
      ? this._buffer
      : [...this._buffer.slice(this._bufferStart), ...this._buffer.slice(0, this._bufferStart)]
    this._buffer = []
    this._bufferStart = 0

    let batch = []
    let batchSize = 0

    for (const event of events) {
      let eventSize
      try {
        eventSize = Buffer.byteLength(JSON.stringify(event))
      } catch (error) {
        log.warn('%s could not serialize an event, dropping event: %s', this.constructor.name, error.message)
        this._droppedEvents++
        continue
      }

      if (this._eventSizeLimit && eventSize > this._eventSizeLimit) {
        log.warn(
          '%s event size %d bytes exceeds limit %d, dropping event',
          this.constructor.name,
          eventSize,
          this._eventSizeLimit
        )
        this._droppedEvents++
        continue
      }

      if (this._payloadSizeLimit && eventSize > this._payloadSizeLimit) {
        log.warn(
          '%s event size %d bytes exceeds payload limit %d, dropping event',
          this.constructor.name,
          eventSize,
          this._payloadSizeLimit
        )
        this._droppedEvents++
        continue
      }

      if (batch.length > 0 && this._payloadSizeLimit && batchSize + eventSize > this._payloadSizeLimit) {
        this.#send(batch)
        batch = []
        batchSize = 0
      }

      batch.push(event)
      batchSize += eventSize
    }

    if (batch.length > 0) {
      this.#send(batch)
    }
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
      clearInterval(this._periodic)
      this.flush()
      globalThis[Symbol.for('dd-trace')].beforeExitHandlers.delete(this.#destroyer)
      this.#destroyer = undefined

      if (this._droppedEvents > 0) {
        log.warn('%s dropped %d events due to buffer overflow', this.constructor.name, this._droppedEvents)
      }
    }
  }

  /**
   * @private
   * @param {Array<object>} payload - Payload to encode
   * @returns {string} JSON-stringified payload
   */
  _encode (payload) {
    return JSON.stringify(payload)
  }

  /**
   * Applies the active route and an optional direct fallback route.
   *
   * @param {WriterRoute} route - Active route
   * @param {WriterRoute} [fallbackRoute] - Direct fallback route
   * @returns {void}
   */
  _setRoutes (route, fallbackRoute) {
    this.#activateRoute(this.#createRoute(route))
    this._fallbackRoute = fallbackRoute ? this.#createRoute(fallbackRoute) : undefined
  }

  /**
   * Sends one event batch.
   *
   * @param {Array<object>} events - Events in the batch
   * @returns {void}
   */
  #send (events) {
    let payload
    try {
      payload = this._encode(this.makePayload(events))
    } catch (error) {
      log.warn(
        '%s could not encode %d event(s), dropping batch: %s',
        this.constructor.name,
        events.length,
        error.message
      )
      this._droppedEvents += events.length
      return
    }

    // eslint-disable-next-line eslint-rules/eslint-log-printf-style
    log.debug(() => `${this.constructor.name} flushing payload: ${safeJSONStringify(payload)}`)

    const route = this.#createActiveRoute()
    this.#sendRequest(payload, events.length, route, this._fallbackRoute)
  }

  /**
   * Creates request state for a configured writer route.
   *
   * @param {WriterRoute} route - Configured route
   * @returns {ActiveWriterRoute} Active route state
   */
  #createRoute (route) {
    const requestOptions = {
      headers: {
        ...route.headers,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      retry: true,
      timeout: this._timeout,
      url: route.url,
      path: route.endpoint,
    }
    if (route.agent) requestOptions.agent = route.agent

    return {
      url: route.url,
      endpoint: route.endpoint,
      requestOptions,
    }
  }

  /**
   * Captures the current route for one event batch.
   *
   * @returns {ActiveWriterRoute} Active route state
   */
  #createActiveRoute () {
    return {
      url: this._baseUrl,
      endpoint: this._endpoint,
      requestOptions: this._requestOptions,
    }
  }

  /**
   * Makes a route active for future event batches.
   *
   * @param {ActiveWriterRoute} route - Route state
   * @returns {void}
   */
  #activateRoute (route) {
    this._baseUrl = route.url
    this._endpoint = route.endpoint
    this._requestOptions = route.requestOptions
  }

  /**
   * Sends an encoded batch and retries it through direct intake after a local route failure.
   *
   * @param {string} payload - Encoded event batch
   * @param {number} eventCount - Event count
   * @param {ActiveWriterRoute} route - Selected route
   * @param {ActiveWriterRoute} [fallbackRoute] - Direct fallback route
   * @returns {void}
   */
  #sendRequest (payload, eventCount, route, fallbackRoute) {
    request(payload, route.requestOptions, (error, response, statusCode) => {
      if (fallbackRoute && isDefinitiveRejection(error, statusCode)) {
        log.debug(
          '%s switching from %s%s to direct intake after definitive rejection',
          this.constructor.name,
          route.url.href,
          route.endpoint
        )
        this.#activateRoute(fallbackRoute)
        this._fallbackRoute = undefined
        this.#sendRequest(payload, eventCount, fallbackRoute)
        return
      }

      if (fallbackRoute && isAmbiguousNetworkFailure(error)) {
        log.debug(
          '%s retrying through direct intake and switching future batches from %s%s after ambiguous failure',
          this.constructor.name,
          route.url.href,
          route.endpoint
        )
        this.#activateRoute(fallbackRoute)
        this._fallbackRoute = undefined
        this.#sendRequest(payload, eventCount, fallbackRoute)
        return
      }

      if (error) {
        log.error('Failed to send events to %s%s: %s', route.url.href, route.endpoint, error.message)
      } else if (statusCode >= 200 && statusCode < 300) {
        log.debug('Successfully sent %d events', eventCount)
      } else {
        log.warn('Events request returned status %d', statusCode)
      }
    })
  }
}

module.exports = BaseFFEWriter
