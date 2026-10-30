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
// Include the in-flight batch in both budgets. Leave headroom in the shared 64 MiB request buffer.
const DELIVERY_MAX_BYTES = 16 * 1024 * 1024
const DELIVERY_MAX_BATCHES = 1000

/**
 * @typedef {object} ExposureRoute
 * @property {URL} url - Route base URL
 * @property {string} basePath - EVP base path
 * @property {object} [headers] - Route-specific headers
 * @property {import('node:https').Agent} [agent] - Optional HTTPS proxy agent
 * @property {ExposureRoute} [fallback] - Optional direct fallback route
 * @property {Function} [onFallback] - Called after direct fallback becomes active
 * @property {Function} [onUnavailable] - Called after the local route becomes unavailable
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
  #deliveryWarned = false
  #closed = false
  #appendDepth = 0
  #inFlight = false
  #deliveryBytes = 0
  #deliveryCount = 0
  /** @type {{ payload: string, eventCount: number, bytes: number }[]} */
  #deliveryQueue = []
  /** @type {ReturnType<typeof setImmediate> | undefined} */
  #deliveryImmediate
  #shutdownDeadline = Infinity
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #shutdownTimer

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
   */
  setEnabled (enabled, route) {
    if (this.#closed) {
      // An outstanding request may discover unavailability during shutdown.
      if (!enabled) {
        this.#enabled = false
        this.#discardDelivery()
      }
      return
    }
    if (route) {
      this.#setRoute(route)
    }

    this.#enabled = enabled

    if (enabled && this.#pendingEvents.length > 0) {
      // Flush all pending events as a batch
      super.append(this.#pendingEvents)
      this.#pendingEvents = []
    }
    if (enabled) this.#scheduleDelivery()
    else this.#cancelDelivery()
  }

  /**
   * Applies caller-supplied route data without performing discovery.
   *
   * @param {ExposureRoute} route - Selected EVP route
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
      onFallback: route.onFallback,
      onUnavailable: route.onUnavailable,
    }, fallbackRoute)
  }

  /**
   * Appends exposure event(s) to the buffer
   * @param {ExposureEvent|ExposureEvent[]} events - Exposure event(s) to append
   */
  append (events) {
    if (this.#closed) return
    if (this.#enabled) {
      this.#appendDepth++
      try {
        super.append(events)
      } finally {
        this.#appendDepth--
      }
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
    // Explicit, periodic and shutdown flushes may start delivery immediately.
    // A byte-triggered flush during append must never initiate transport inline.
    if (this.#appendDepth === 0) this.#drainDelivery()
  }

  destroy () {
    if (this.#closed) return
    this.#closed = true
    this.#shutdownDeadline = Date.now() + this._timeout
    this.#shutdownTimer = setTimeout(() => {
      this.#shutdownTimer = undefined
      const before = this._droppedEvents
      this.#discardDelivery()
      const dropped = this._droppedEvents - before
      if (dropped > 0) {
        log.warn('%s shutdown deadline reached, dropping %d queued events', this.constructor.name, dropped)
      }
    }, this._timeout)
    this.#shutdownTimer.unref?.()
    if (!this.#enabled) {
      this._droppedEvents += this.#pendingEvents.length + this._buffer.length
      this.#pendingEvents = []
      this._buffer = []
      this._bufferSize = 0
      this.#discardDelivery()
    }
    super.destroy()
  }

  /**
   * Queues an encoded exposure batch, keeping accepted batches when capacity is exhausted.
   * @param {string} payload - Encoded payload
   * @param {number} eventCount - Number of exposures
   */
  _sendPayload (payload, eventCount) {
    const bytes = Buffer.byteLength(payload)
    if (this.#deliveryBytes + bytes > DELIVERY_MAX_BYTES || this.#deliveryCount >= DELIVERY_MAX_BATCHES) {
      this._droppedEvents += eventCount
      if (!this.#deliveryWarned) {
        this.#deliveryWarned = true
        log.warn('%s delivery queue full, dropping newest batch', this.constructor.name)
      }
      return
    }
    this.#deliveryQueue.push({ payload, eventCount, bytes })
    this.#deliveryBytes += bytes
    this.#deliveryCount++
    this.#scheduleDelivery()
  }

  #scheduleDelivery () {
    if (this.#deliveryQueue.length === 0) {
      if (!this.#inFlight) this.#cancelShutdownTimer()
      return
    }
    if (!this.#enabled || this.#inFlight || this.#deliveryImmediate) return
    // Only the bounded shutdown drain should keep an otherwise idle process alive.
    this.#deliveryImmediate = setImmediate(() => {
      this.#deliveryImmediate = undefined
      this.#drainDelivery()
    })
    if (!this.#closed) this.#deliveryImmediate.unref?.()
  }

  #cancelShutdownTimer () {
    clearTimeout(this.#shutdownTimer)
    this.#shutdownTimer = undefined
  }

  #cancelDelivery () {
    if (!this.#deliveryImmediate) return
    clearImmediate(this.#deliveryImmediate)
    this.#deliveryImmediate = undefined
  }

  #discardDelivery () {
    this.#cancelDelivery()
    this.#cancelShutdownTimer()
    for (const batch of this.#deliveryQueue) {
      this._droppedEvents += batch.eventCount
      this.#deliveryBytes -= batch.bytes
      this.#deliveryCount--
    }
    this.#deliveryQueue = []
  }

  #drainDelivery () {
    this.#cancelDelivery()
    if (Date.now() >= this.#shutdownDeadline) {
      this.#discardDelivery()
      return
    }
    if (!this.#enabled || this.#inFlight) return
    const batch = this.#deliveryQueue.shift()
    if (!batch) {
      this.#cancelShutdownTimer()
      return
    }
    this.#inFlight = true
    super._sendPayload(batch.payload, batch.eventCount, delivered => {
      this.#inFlight = false
      this.#deliveryBytes -= batch.bytes
      this.#deliveryCount--
      if (!delivered) this._droppedEvents += batch.eventCount
      // Yield even when a transport implementation invokes its callback synchronously.
      this.#scheduleDelivery()
    })
  }

  /**
   * Formats exposure events with service context metadata
   * @param {Array<ExposureEvent>} events - Array of exposure events
   * @returns {ExposureEventPayload} Formatted payload with service context
   */
  makePayload (events) {
    const formattedEvents = events.map(event => {
      /** @type {ExposureEvent} */
      const formatted = {
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

      if (typeof event.serial_id === 'number') {
        formatted.serial_id = event.serial_id
      }

      return formatted
    })

    return {
      context: this.#context,
      exposures: formattedEvents,
    }
  }
}

module.exports = ExposuresWriter
