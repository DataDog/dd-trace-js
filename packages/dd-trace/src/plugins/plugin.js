'use strict'

// TODO: move anything related to tracing to TracingPlugin instead

const dc = require('dc-polyfill')
const logger = require('../log')
const { storage } = require('../../../datadog-core')

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
      const store = storage('legacy').getStore()
      if (!store || !store.noop) {
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
      const store = storage('legacy').getStore()

      return !store || !store.noop || (data && Object.hasOwn(data, 'currentStore'))
        ? transform(data)
        : store
    }
  }

  enable () {
    this._channel.bindStore(storage('legacy'), this._transform)
  }

  disable () {
    this._channel.unbindStore(storage('legacy'))
  }
}

module.exports = class Plugin {
  /**
   * Create a new plugin instance.
   *
   * @param {object} tracer Tracer instance or wrapper containing it under `_tracer`.
   * @param {object} tracerConfig Global tracer configuration object.
   */
  constructor (tracer, tracerConfig) {
    this._subscriptions = []
    this._bindings = []
    this._enabled = false
    this._tracer = tracer
    this.config = {} // plugin-specific configuration, unset until .configure() is called
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
   * @param {object} span The span to bind as current.
   * @param {object=} store Optional existing store to extend; if omitted, uses current store.
   * @returns {void}
   */
  enter (span, store) {
    store = store || storage('legacy').getStore()
    storage('legacy').enterWith({ ...store, span })
  }

  // TODO: Implement filters on resource name for all plugins.
  /** Prevents creation of spans here and for all async descendants. */
  skip () {
    storage('legacy').enterWith({ noop: true })
  }

  /**
   * Subscribe to a diagnostic channel with automatic error handling and enable/disable lifecycle.
   *
   * @param {string} channelName Diagnostic channel name.
   * @param {(...args: unknown[]) => unknown} handler Handler invoked on messages.
   * @returns {void}
   */
  addSub (channelName, handler) {
    const plugin = this
    /**
     * @this {unknown}
     * @returns {unknown}
     */
    const wrappedHandler = function () {
      try {
        return handler.apply(this, arguments)
      } catch (e) {
        logger.error('Error in plugin handler:', e)
        logger.info('Disabling plugin: %s', plugin.id)
        plugin.configure(false)
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
    const store = storage('legacy').getStore()

    if (!store || !store.span) return

    if (!store.span._spanContext._tags.error) {
      store.span.setTag('error', error || 1)
    }
  }

  /**
   * Enable or disable the plugin and (re)apply its configuration.
   *
   * @param {boolean|object} config Either a boolean to enable/disable or a configuration object
   *                                containing at least `{ enabled: boolean }`.
   * @returns {void}
   */
  configure (config) {
    if (typeof config === 'boolean') {
      config = { enabled: config }
    }
    this.config = config
    if (config.enabled && !this._enabled) {
      this._enabled = true
      this._subscriptions.forEach(sub => sub.enable())
      this._bindings.forEach(sub => sub.enable())
    } else if (!config.enabled && this._enabled) {
      this._enabled = false
      this._subscriptions.forEach(sub => sub.disable())
      this._bindings.forEach(sub => sub.disable())
    }
  }
}
