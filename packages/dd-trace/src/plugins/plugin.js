'use strict'

// TODO: move anything related to tracing to TracingPlugin instead

const dc = require('dc-polyfill')
const logger = require('../log')
const { storage } = require('../../../datadog-core')

const legacyStorage = storage('legacy')

/** @typedef {Record<string, unknown> & { enabled: boolean }} PluginConfig */

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
  #handler
  #disableOption
  #enabled = false

  /**
   * @param {string} event
   * @param {Function} handler
   * @param {string} [disableOption]
   */
  constructor (event, handler, disableOption) {
    this._channel = dc.channel(event)
    this.#disableOption = disableOption
    this.#handler = (message, name) => {
      if (!legacyStorage.getHandle()?.noop) {
        handler(message, name)
      }
    }
  }

  /**
   * @param {PluginConfig} config
   */
  configure (config) {
    const enabled = config.enabled && (this.#disableOption === undefined || config[this.#disableOption] !== false)
    if (enabled === this.#enabled) return

    if (enabled) {
      this.enable()
    } else {
      this.disable()
    }
  }

  enable () {
    // The channel methods support Node.js versions before 18.6.0.
    this._channel.subscribe(this.#handler)
    this.#enabled = true
  }

  disable () {
    this._channel.unsubscribe(this.#handler)
    this.#enabled = false
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
   * @param {object} span The span to bind as current.
   * @param {object=} store Optional existing store to extend; if omitted, uses current store.
   */
  enter (span, store) {
    store ||= legacyStorage.getStore()
    legacyStorage.enterWith({ ...store, span })
  }

  /**
   * Subscribe to a diagnostic channel with automatic error handling and enable/disable lifecycle.
   *
   * @template T
   * @param {string} channelName Diagnostic channel name.
   * @param {(message: T, name: string) => unknown} handler Handler invoked on messages.
   * @param {string} [disableOption] Keep this subscription inactive when the option is false.
   */
  addSub (channelName, handler, disableOption) {
    const wrappedHandler = (message, name) => {
      try {
        return handler.call(this, message, name)
      } catch (error) {
        logger.error('Error in plugin handler:', error)
        logger.info('Disabling plugin: %s', this.constructor.name)
        this.configure(false)
      }
    }
    this._subscriptions.push(new Subscription(channelName, wrappedHandler, disableOption))
  }

  /**
   * Bind the tracer store to a diagnostic channel with a transform function.
   *
   * @template T
   * @param {string} channelName Diagnostic channel name.
   * @param {(data: T) => object} transform Transform to compute the bound store.
   */
  addBind (channelName, transform) {
    this._bindings.push(new StoreBinding(channelName, transform))
  }

  /**
   * Attach an error to the current active span (if any).
   *
   * @param {unknown} error Error object or sentinel value.
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
   * @param {boolean | PluginConfig} config Either a boolean to
   * enable/disable or a configuration object containing at least `{ enabled: boolean }`.
   */
  configure (config) {
    if (typeof config === 'boolean') {
      config = { enabled: config }
    }
    this.config = config
    const wasEnabled = this._enabled
    const enabled = config.enabled
    this._enabled = enabled

    if (enabled || wasEnabled) {
      for (const sub of this._subscriptions) {
        sub.configure(config)
      }
    }

    if (enabled !== wasEnabled) {
      for (const sub of this._bindings) {
        if (enabled) {
          sub.enable()
        } else {
          sub.disable()
        }
      }
    }
  }
}
