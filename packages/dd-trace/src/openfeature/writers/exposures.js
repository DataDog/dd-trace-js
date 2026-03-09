'use strict'

const {
  EXPOSURES_ENDPOINT,
  EVP_PROXY_AGENT_BASE_PATH,
  EVP_SUBDOMAIN_HEADER_NAME,
  EVP_SUBDOMAIN_VALUE,
  EVP_PAYLOAD_SIZE_LIMIT,
  EVP_EVENT_SIZE_LIMIT,
} = require('../constants/constants')
const BaseFFEWriter = require('./base')

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
  #enabled
  #pendingEvents
  #context

  /**
   * @param {import('../../config')} config - Tracer configuration object
   */
  constructor (config) {
    // Build full EVP endpoint path
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
    this.#enabled = false // Start disabled until agent strategy is set
    this.#pendingEvents = [] // Buffer events until enabled
    this.#context = this._buildContext()
  }

  // Exposed for test access
  // TODO: Refactor to use proxyquire or sinon
  get _pendingEvents () { return this.#pendingEvents }

  /**
   * @param {boolean} enabled - Whether to enable the writer
   */
  setEnabled (enabled) {
    this.#enabled = enabled

    if (enabled && this.#pendingEvents.length > 0) {
      // Flush all pending events as a batch
      super.append(this.#pendingEvents)
      this.#pendingEvents = []
    }
  }

  /**
   * Appends exposure event(s) to the buffer
   * @param {ExposureEvent|ExposureEvent[]} events - Exposure event(s) to append
   */
  append (events) {
    if (!this.#enabled) {
      // Buffer events until writer is ready
      if (Array.isArray(events)) {
        this.#pendingEvents.push(...events)
      } else {
        this.#pendingEvents.push(events)
      }
      return
    }
    super.append(events)
  }

  /**
   * Flushes buffered exposure events to the agent
   */
  flush () {
    if (!this.#enabled) {
      // Don't flush when disabled
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
    const formattedEvents = events.map(event => this._formatExposureEvent(event))

    return {
      context: this.#context,
      exposures: formattedEvents,
    }
  }

  /**
   * Builds service context metadata
   * @private
   * @returns {ExposureContext} Service context
   */
  _buildContext () {
    const context = {
      service: this._config.service || 'unknown',
    }

    // Only include version and env if they are defined
    if (this._config.version !== undefined) {
      context.version = this._config.version
    }

    if (this._config.env !== undefined) {
      context.env = this._config.env
    }

    return context
  }

  /**
   * @private
   * @param {ExposureEvent} event - Raw exposure event
   * @returns {ExposureEvent} Formatted exposure event
   */
  _formatExposureEvent (event) {
    // Ensure the event matches the expected schema
    const formattedEvent = {
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
    return formattedEvent
  }
}

module.exports = ExposuresWriter
