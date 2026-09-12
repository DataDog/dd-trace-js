'use strict'

const request = require('../../exporters/common/request')

const log = require('../../log')
const tracerVersion = require('../../../../../package.json').version

const EVP_ORIGIN_HEADERS = {
  'DD-EVP-ORIGIN': 'dd-trace-js',
  'DD-EVP-ORIGIN-VERSION': tracerVersion,
}

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
 * @property {Function} [onFallback] - Called after direct fallback becomes active
 * @property {Function} [onUnavailable] - Called after the local route becomes unavailable
 */

/**
 * @typedef {object} ActiveWriterRoute
 * @property {URL} url - Route base URL
 * @property {string} endpoint - Route endpoint
 * @property {object} requestOptions - HTTP request options
 * @property {Function} [onFallback] - Called after direct fallback becomes active
 * @property {Function} [onUnavailable] - Called after the local route becomes unavailable
 */

/**
 * Tests whether a local route definitively rejected an event batch.
 *
 * @param {Error | null} error - Request error
 * @param {number | undefined} statusCode - HTTP response status
 * @returns {boolean} Whether direct retry is safe
 */
function isSafeToReplay (error, statusCode) {
  return error?.code === 'EAI_AGAIN' || error?.code === 'ECONNREFUSED' ||
    error?.code === 'ENOENT' || error?.code === 'ENOTFOUND' ||
    statusCode === 404 || statusCode === 405
}

/**
 * Tests whether a local route failed without an authoritative HTTP response.
 *
 * @param {Error | null} error - Request error
 * @param {number | undefined} statusCode - HTTP response status
 * @returns {boolean} Whether the delivery result is ambiguous
 */
function isTransportFailure (error, statusCode) {
  return error !== null && error !== undefined && statusCode === undefined
}

/**
 * Tests whether an HTTP response should move only future Agentless batches.
 *
 * @param {number | undefined} statusCode - HTTP response status
 * @returns {boolean} Whether the local route should be replaced without replay
 */
function shouldSwitchFutureRoute (statusCode) {
  return statusCode === 403 || statusCode === 429 || statusCode >= 500 && statusCode < 600
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
    this._bufferSize = 0

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
        ...EVP_ORIGIN_HEADERS,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      retry: false,
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
      if (this._buffer.length >= this._bufferLimit) {
        log.warn('%s event buffer full (limit is %d), dropping event', this.constructor.name, this._bufferLimit)
        this._droppedEvents++
        continue
      }

      const eventSizeBytes = Buffer.byteLength(JSON.stringify(event))

      // Check individual event size limit if configured
      if (this._eventSizeLimit && eventSizeBytes > this._eventSizeLimit) {
        log.warn('%s event size %d bytes exceeds limit %d, dropping event',
          this.constructor.name, eventSizeBytes, this._eventSizeLimit)
        this._droppedEvents++
        continue
      }

      // Check if adding this event would exceed payload size limit if configured
      if (this._payloadSizeLimit && this._bufferSize + eventSizeBytes > this._payloadSizeLimit) {
        log.debug('%s buffer size would exceed %d bytes, flushing first', this.constructor.name, this._payloadSizeLimit)
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

    // Keep byte counting behind the debug callback because payloads can be several megabytes.
    // eslint-disable-next-line eslint-rules/eslint-log-printf-style
    log.debug(() => `${this.constructor.name} flushing ${events.length} events (${Buffer.byteLength(payload)} bytes)`)
    this._sendPayload(payload, events.length)
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
   * Sends one encoded event batch through a snapshot of the selected routes.
   *
   * @protected
   * @param {string} payload - Encoded event batch
   * @param {number} eventCount - Event count
   * @returns {void}
   */
  _sendPayload (payload, eventCount) {
    const route = this.#createActiveRoute()
    this.#sendRequest(payload, eventCount, route, this._fallbackRoute)
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
   * Creates request state for a configured writer route.
   *
   * @param {WriterRoute} route - Configured route
   * @returns {ActiveWriterRoute} Active route state
   */
  #createRoute (route) {
    const requestOptions = {
      headers: {
        ...route.headers,
        ...EVP_ORIGIN_HEADERS,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      retry: false,
      timeout: this._timeout,
      url: route.url,
      path: route.endpoint,
    }
    if (route.agent) requestOptions.agent = route.agent

    return {
      url: route.url,
      endpoint: route.endpoint,
      requestOptions,
      onFallback: route.onFallback,
      onUnavailable: route.onUnavailable,
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
      onFallback: this._onFallback,
      onUnavailable: this._onUnavailable,
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
    this._onFallback = route.onFallback
    this._onUnavailable = route.onUnavailable
  }

  /**
   * Sends an encoded batch once per route and applies safe local fallback semantics.
   *
   * @param {string} payload - Encoded event batch
   * @param {number} eventCount - Event count
   * @param {ActiveWriterRoute} route - Selected route
   * @param {ActiveWriterRoute} [fallbackRoute] - Direct fallback route
   * @returns {void}
   */
  #sendRequest (payload, eventCount, route, fallbackRoute) {
    request(payload, route.requestOptions, (error, response, statusCode) => {
      if (fallbackRoute && isSafeToReplay(error, statusCode)) {
        log.debug(
          '%s switching from %s%s to direct intake after definitive rejection',
          this.constructor.name,
          route.url.href,
          route.endpoint
        )
        this.#activateRoute(fallbackRoute)
        this._fallbackRoute = undefined
        route.onFallback?.()
        this.#sendRequest(payload, eventCount, fallbackRoute)
        return
      }

      if (fallbackRoute && isTransportFailure(error, statusCode)) {
        log.debug(
          '%s switching future batches from %s%s to direct intake after an ambiguous failure without replay',
          this.constructor.name,
          route.url.href,
          route.endpoint
        )
        this.#activateRoute(fallbackRoute)
        this._fallbackRoute = undefined
        route.onFallback?.()
        log.error('Failed to send events to %s%s: %s', route.url.href, route.endpoint, error.message)
        return
      }

      if (fallbackRoute && shouldSwitchFutureRoute(statusCode)) {
        log.debug(
          '%s switching future batches from %s%s to direct intake after status %d without replay',
          this.constructor.name,
          route.url.href,
          route.endpoint,
          statusCode
        )
        this.#activateRoute(fallbackRoute)
        this._fallbackRoute = undefined
        route.onFallback?.()
        log.warn('Events request returned status %d', statusCode)
        return
      }

      if (
        !fallbackRoute &&
        route.onUnavailable &&
        (isSafeToReplay(error, statusCode) ||
          isTransportFailure(error, statusCode) ||
          shouldSwitchFutureRoute(statusCode))
      ) {
        route.onUnavailable()
        if (error) {
          log.error('Failed to send events to %s%s: %s', route.url.href, route.endpoint, error.message)
        } else {
          log.warn('Events request returned status %d', statusCode)
        }
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
