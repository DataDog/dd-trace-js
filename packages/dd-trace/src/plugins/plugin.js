'use strict'

// TODO: move anything related to tracing to TracingPlugin instead

const dc = require('dc-polyfill')
const logger = require('../log')
const { storage } = require('../../../datadog-core')

const legacyStorage = storage('legacy')

/**
 * Base class for all Datadog plugins.
 *
 * Subclasses MUST define a static field `id` with the integration identifier
 * used across channels, span names, tags and telemetry.
 *
 * Example:
 * ```js
 * class MyPlugin extends Plugin {
 *   static id = 'myframework'
 * }
 * ```
 *
 * Notes about the tracer instance:
 * - In some contexts the tracer may be wrapped and available as `{ _tracer: Tracer }`.
 *   Use the `tracer` getter which normalizes access.
 */

class Subscription {
  constructor (event, handler) {
    this._channel = dc.channel(event)
    this._handler = (message, name) => {
      if (!legacyStorage.getHandle()?.noop) {
        handler(message, name)
      }
    }
  }

  enable () {
    // TODO: Once Node.js v18.6.0 is no longer supported, we should use `dc.subscribe(event, handler)` instead
    this._channel.subscribe(this._handler)
  }

  disable () {
    // TODO: Once Node.js v18.6.0 is no longer supported, we should use `dc.unsubscribe(event, handler)` instead
    this._channel.unsubscribe(this._handler)
  }
}

class StoreBinding {
  constructor (event, transform) {
    this._channel = dc.channel(event)
    this._transform = data => {
      const handle = legacyStorage.getHandle()

      return !handle?.noop || (data && Object.hasOwn(data, 'currentStore'))
        ? transform(data)
        : legacyStorage.getStore()
    }
  }

  enable () {
    this._channel.bindStore(legacyStorage, this._transform)
  }

  disable () {
    this._channel.unbindStore(legacyStorage)
  }
}

module.exports = class Plugin {
  /**
   * Create a new plugin instance.
   *
   * @param {object} tracer Tracer instance or wrapper containing it under `_tracer`.
   * @param {import('../config/config-base')} tracerConfig Global tracer configuration object.
   */
  constructor (tracer, tracerConfig) {
    this._subscriptions = []
    this._bindings = []
    this._enabled = false
    this._tracer = tracer
    this.config = {} // plugin-specific configuration, unset until .configure() is called

    /** @type {import('../config/config-base')} */
    this._tracerConfig = tracerConfig // global tracer configuration
  }

  /**
   * Normalized tracer access. Returns the underlying tracer even if wrapped.
   *
   * @returns {object}
   */
  get tracer () {
    return this._tracer?._tracer || this._tracer
  }

  /**
   * Enter a context with the provided span bound in storage.
   *
   * A fresh `{ ...store, span }` object is written into the current
   * async-context frame, so any async resource created while it is active
   * snapshots the frame and keeps that object — and its `span` — reachable for
   * the resource's whole lifetime, even after the span finishes. A caller whose
   * span outlives the request should keep the returned store and null its `span`
   * once the span is finished and no in-scope continuation can still read it as
   * active; otherwise a never-freed resource pins the finished span (and its
   * parent chain) forever.
   *
   * @param {object} span The span to bind as current.
   * @param {object=} store Optional existing store to extend; if omitted, uses current store.
   * @returns {{ span: object | null }} The store object written into storage.
   */
  enter (span, store) {
    const activeStore = { ...(store || legacyStorage.getStore()), span }
    legacyStorage.enterWith(activeStore)
    return activeStore
  }

  /**
   * Subscribe to a diagnostic channel with automatic error handling and enable/disable lifecycle.
   *
   * @param {string} channelName Diagnostic channel name.
   * @param {(message: unknown, name: string) => unknown} handler Handler invoked on messages.
   * @returns {void}
   */
  addSub (channelName, handler) {
    const wrappedHandler = (message, name) => {
      try {
        return handler.call(this, message, name)
      } catch (error) {
        logger.error('Error in plugin handler:', error)
        logger.info('Disabling plugin: %s', this.constructor.name)
        this.configure(false)
      }
    }
    this._subscriptions.push(new Subscription(channelName, wrappedHandler))
  }

  /**
   * Bind the tracer store to a diagnostic channel with a transform function.
   *
   * @param {string} channelName Diagnostic channel name.
   * @param {(data: unknown) => object} transform Transform to compute the bound store.
   * @returns {void}
   */
  addBind (channelName, transform) {
    this._bindings.push(new StoreBinding(channelName, transform))
  }

  /**
   * Attach an error to the current active span (if any).
   *
   * @param {unknown} error Error object or sentinel value.
   * @returns {void}
   */
  addError (error) {
    const store = legacyStorage.getStore()

    if (!store || !store.span) return

    const span = /** @type {import('../opentracing/span')} */ (store.span)
    if (!span.context().getTag('error')) {
      span.setTag('error', error || 1)
    }
  }

  /**
   * Enable or disable the plugin and (re)apply its configuration.
   *
   * @param {boolean | Record<string, unknown> & {enabled: boolean}} config Either a boolean to
   * enable/disable or a configuration object containing at least `{ enabled: boolean }`.
   */
  configure (config) {
    if (typeof config === 'boolean') {
      config = { enabled: config }
    }
    this.config = config
    if (config.enabled) {
      if (!this._enabled) {
        this._enabled = true
        for (const sub of this._subscriptions) {
          sub.enable()
        }
        for (const sub of this._bindings) {
          sub.enable()
        }
      }
    } else if (this._enabled) {
      this._enabled = false
      for (const sub of this._subscriptions) {
        sub.disable()
      }
      for (const sub of this._bindings) {
        sub.disable()
      }
    }
  }
}
