'use strict'

const {
  EXPOSURES_ENDPOINT,
  EVP_PAYLOAD_SIZE_LIMIT,
  EVP_EVENT_SIZE_LIMIT,
} = require('../constants/constants')
const {
  EVP_EVENT_PLATFORM_SUBDOMAIN,
  EVP_PROXY_PATH_V2,
  EVP_SUBDOMAIN_HEADER_NAME,
} = require('../../evp_proxy/constants')
const { joinEVPProxyPath } = require('../../evp_proxy/path')
const log = require('../../log')
const BaseFFEWriter = require('./base')

// Disabled-state cap. Drops invalidate experiment results because the provider's
// exposure dedupe cache keeps masking dropped events after recovery. The first
// drop emits a warning and `droppedEventCount` accumulates the cumulative loss.
const PENDING_MAX_EVENTS = 1000

/**
 * @typedef {object} ExposureRoute
 * @property {URL} url - Route base URL
 * @property {string} basePath - EVP base path
 * @property {object} [headers] - Route-specific headers
 * @property {import('node:https').Agent} [agent] - Optional HTTPS proxy agent
 * @property {ExposureRoute} [fallback] - Optional direct fallback route
 */

/**
 * @typedef {object} ExposureEvent
 * @property {number} timestamp - Unix timestamp in milliseconds
 * @property {object} allocation - Allocation information
 * @property {string} allocation.key - Allocation key
 * @property {object} flag - Flag information
 * @property {string} flag.key - Flag key
 * @property {object} variant - Variant information
 * @property {string} variant.key - Variant key
 * @property {number} [serial_id] - Serial id of the split the subject landed in
 * @property {object} subject - Subject (user/entity) information
 * @property {string} subject.id - Subject identifier
 * @property {string} [subject.type] - Subject type
 * @property {object} [subject.attributes] - Additional subject attributes
 */

/**
 * @typedef {object} ExposureContext
 * @property {string} service - Service name
 * @property {string} [version] - Service version
 * @property {string} [env] - Service environment
 */

/**
 * @typedef {object} ExposureEventPayload
 * @property {ExposureContext} context - Service context metadata
 * @property {ExposureEvent[]} exposures - Formatted exposure events
 */

/**
 * Sends exposure events through the selected local EVP proxy or direct intake route.
 */
class ExposuresWriter extends BaseFFEWriter {
  // Disabled until route selection resolves.
  #enabled = false

  /** @type {ExposureEvent[]} */
  #pendingEvents = []

  /** @type {ExposureContext} */
  #context

  #dropWarned = false

  /**
   * @param {import('../../config/config-base')} config - Tracer configuration object
   * @param {ExposureRoute} [route] - Caller-supplied route
   */
  constructor (config, route) {
    route ??= { url: config.url, basePath: EVP_PROXY_PATH_V2 }
    const headers = route.headers ?? {
      [EVP_SUBDOMAIN_HEADER_NAME]: EVP_EVENT_PLATFORM_SUBDOMAIN,
    }

    super({
      config,
      agentUrl: route.url,
      endpoint: joinEVPProxyPath(route.basePath, EXPOSURES_ENDPOINT),
      payloadSizeLimit: EVP_PAYLOAD_SIZE_LIMIT,
      eventSizeLimit: EVP_EVENT_SIZE_LIMIT,
      headers,
    })

    if (route.agent || route.fallback) {
      this.#setRoute({ ...route, headers })
    }

    /** @type {ExposureContext} */
    const context = {
      service: config.service,
    }

    if (config.version !== undefined) {
      context.version = config.version
    }

    if (config.env !== undefined) {
      context.env = config.env
    }

    this.#context = context
  }

  /**
   * @param {boolean} enabled - Whether to enable the writer
   * @param {ExposureRoute} [route] - Selected EVP route
   * @returns {void}
   */
  setEnabled (enabled, route) {
    if (route) {
      this.#setRoute(route)
    }

    this.#enabled = enabled

    if (enabled && this.#pendingEvents.length > 0) {
      // Flush all pending events as a batch
      super.append(this.#pendingEvents)
      this.#pendingEvents = []
    }
  }

  /**
   * Applies caller-supplied route data without performing discovery.
   *
   * @param {ExposureRoute} route - Selected EVP route
   * @returns {void}
   */
  #setRoute (route) {
    const fallbackRoute = route.fallback && {
      url: route.fallback.url,
      endpoint: joinEVPProxyPath(route.fallback.basePath, EXPOSURES_ENDPOINT),
      headers: route.fallback.headers ?? {},
      agent: route.fallback.agent,
    }
    const headers = route.headers ?? {
      [EVP_SUBDOMAIN_HEADER_NAME]: EVP_EVENT_PLATFORM_SUBDOMAIN,
    }

    this._setRoutes({
      url: route.url,
      endpoint: joinEVPProxyPath(route.basePath, EXPOSURES_ENDPOINT),
      headers,
      agent: route.agent,
    }, fallbackRoute)
  }

  /**
   * Appends exposure event(s) to the buffer
   * @param {ExposureEvent|ExposureEvent[]} events - Exposure event(s) to append
   */
  append (events) {
    if (this.#enabled) {
      super.append(events)
      return
    }

    const eventArray = Array.isArray(events) ? events : [events]
    this.#pendingEvents.push(...eventArray)
    if (this.#pendingEvents.length > PENDING_MAX_EVENTS) {
      const dropped = this.#pendingEvents.length - PENDING_MAX_EVENTS
      this.#pendingEvents.splice(0, dropped)
      this._droppedEvents += dropped
      if (!this.#dropWarned) {
        this.#dropWarned = true
        log.warn(
          '%s dropped exposure event(s) at cap %d. This may invalidate experiment results.',
          this.constructor.name, PENDING_MAX_EVENTS)
      }
    }
  }

  /**
   * @returns {number} Cumulative number of exposure events dropped due to buffer overflow.
   */
  get droppedEventCount () {
    return this._droppedEvents
  }

  /**
   * Flushes buffered exposure events to the agent
   */
  flush () {
    if (!this.#enabled) {
      return
    }
    super.flush()
  }

  /**
   * Formats exposure events with service context metadata
   * @param {Array<ExposureEvent>} events - Array of exposure events
   * @returns {ExposureEventPayload} Formatted payload with service context
   */
  makePayload (events) {
    const formattedEvents = events.map(event => {
      /** @type {ExposureEvent} */
      return {
        timestamp: event.timestamp || Date.now(),
        allocation: {
          key: event.allocation?.key || event['allocation.key'],
        },
        flag: {
          key: event.flag?.key || event['flag.key'],
        },
        variant: {
          key: event.variant?.key || event['variant.key'],
        },
        ...(typeof event.serial_id === 'number' ? { serial_id: event.serial_id } : {}),
        subject: {
          id: event.subject?.id || event['subject.id'],
          type: event.subject?.type,
          attributes: event.subject?.attributes,
        },
      }
    })

    return {
      context: this.#context,
      exposures: formattedEvents,
    }
  }
}

module.exports = ExposuresWriter
