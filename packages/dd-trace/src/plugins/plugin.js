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
   * @param {object} span The span to bind as current.
   * @param {object=} store Optional existing store to extend; if omitted, uses current store.
   * @returns {object} The store object that was entered, so callers can later
   * release its `span` reference via {@link Plugin#releaseSpan}.
   */
  enter (span, store) {
    store = store || legacyStorage.getStore()
    // The entered store is a fresh object captured by the current async-context
    // frame (and by any async resource created while this store is active).
    // Return it so callers can later release its `span` reference once that span
    // has finished, preventing finished spans from being retained for the life
    // of any async resource that snapshotted the frame. See `releaseSpan`.
    const enteredStore = { ...store, span }
    legacyStorage.enterWith(enteredStore)
    return enteredStore
  }

  /**
   * Release the finished span from a store previously produced by `enter()`.
   *
   * `enter()` activates a span by writing a `{ ...store, span }` object into the
   * current async-context frame. Any async resource created while that store is
   * active snapshots the frame and therefore keeps the store — and its `span`
   * property — reachable for the resource's entire lifetime, even after the span
   * has finished. For never-released resources (subscriptions, un-removed
   * listeners, queued callbacks) this pins finished spans forever, leaking the
   * whole parent chain via each span's own captured store.
   *
   * Callers must only release a store once no further work can legitimately read
   * its span as the active span — i.e. after the operation and any of its
   * in-scope async continuation is done. Releasing too early (e.g. while a
   * callback scheduled by the operation is still pending) would orphan that
   * callback's spans and break log correlation. Once it is safe, nulling the
   * reference lets the finished span (and its parent chain) be garbage collected
   * while the capturing resource lives on.
   *
   * @param {object=} store A store object returned by `enter()`.
   * @returns {void}
   */
  releaseSpan (store) {
    if (store && store.span) {
      store.span = null
    }
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
