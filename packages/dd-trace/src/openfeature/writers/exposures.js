'use strict'

const {
  EXPOSURES_ENDPOINT,
  EVP_PROXY_AGENT_BASE_PATH,
  EVP_SUBDOMAIN_HEADER_NAME,
  EVP_SUBDOMAIN_VALUE,
  EVP_PAYLOAD_SIZE_LIMIT,
  EVP_EVENT_SIZE_LIMIT,
} = require('../constants/constants')
const log = require('../../log')
const BaseFFEWriter = require('./base')

// Disabled-state cap. Drops invalidate experiment results because the provider's
// exposure dedupe cache keeps masking dropped events after recovery. The first
// drop emits a warning and `droppedEventCount` accumulates the cumulative loss.
const PENDING_MAX_EVENTS = 1000

/**
 * @typedef {object} ExposureEvent
 * @property {number} timestamp - Unix timestamp in milliseconds
 * @property {object} allocation - Allocation information
 * @property {string} allocation.key - Allocation key
 * @property {object} flag - Flag information
 * @property {string} flag.key - Flag key
 * @property {object} variant - Variant information
 * @property {string} variant.key - Variant key
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
 * ExposuresWriter is responsible for sending exposure events to the Datadog Agent.
 */
class ExposuresWriter extends BaseFFEWriter {
  // Disabled until the agent strategy probe resolves.
  #enabled = false

  /** @type {ExposureEvent[]} */
  #pendingEvents = []

  /** @type {ExposureContext} */
  #context

  #dropWarned = false

  /**
   * @param {import('../../config')} config - Tracer configuration object
   */
  constructor (config) {
    const basePath = EVP_PROXY_AGENT_BASE_PATH.replace(/\/+$/, '')
    const endpoint = EXPOSURES_ENDPOINT.replace(/^\/+/, '')
    const fullEndpoint = `${basePath}/${endpoint}`

    super({
      config,
      endpoint: fullEndpoint,
      payloadSizeLimit: EVP_PAYLOAD_SIZE_LIMIT,
      eventSizeLimit: EVP_EVENT_SIZE_LIMIT,
      headers: {
        [EVP_SUBDOMAIN_HEADER_NAME]: EVP_SUBDOMAIN_VALUE,
      },
    })
    this.#context = this.#buildContext()
  }

  /**
   * @param {boolean} enabled - Whether to enable the writer
   */
  setEnabled (enabled) {
    this.#enabled = enabled

    if (enabled && this.#pendingEvents.length > 0) {
      const events = this.#pendingEvents
      this.#pendingEvents = []
      super.append(events)
    }
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
          '%s dropped %d exposure event(s) at cap %d. Provider dedupe cache may invalidate experiment results.',
          this.constructor.name, dropped, PENDING_MAX_EVENTS)
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
    const formattedEvents = events.map(event => this.#formatExposureEvent(event))

    return {
      context: this.#context,
      exposures: formattedEvents,
    }
  }

  /**
   * @returns {ExposureContext} Service context
   */
  #buildContext () {
    const context = {
      service: this._config.service || 'unknown',
    }

    if (this._config.version !== undefined) {
      context.version = this._config.version
    }

    if (this._config.env !== undefined) {
      context.env = this._config.env
    }

    return context
  }

  /**
   * @param {ExposureEvent} event - Raw exposure event
   * @returns {ExposureEvent} Formatted exposure event
   */
  #formatExposureEvent (event) {
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
      subject: {
        id: event.subject?.id || event['subject.id'],
        type: event.subject?.type,
        attributes: event.subject?.attributes,
      },
    }
  }
}

module.exports = ExposuresWriter
