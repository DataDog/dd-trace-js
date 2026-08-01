'use strict'

/**
 * The vendored `@datadog/openfeature-node-server` build cannot depend on its own copy of
 * `@openfeature/server-sdk` -- doing so would bundle a second, distinct copy of the SDK, giving
 * `instanceof` checks and enum comparisons (e.g. `ProviderEvents`) a different identity than the
 * copy the customer's own application uses. `vendor/rspack.config.js` marks
 * `@openfeature/server-sdk` external and points it at this module instead.
 *
 * The vendored provider constructs `new OpenFeatureEventEmitter()` eagerly, in its own
 * constructor, before the customer's app has necessarily required `@openfeature/server-sdk`.
 * `OpenFeatureEventEmitter` below stands in for the real class so construction always succeeds,
 * and only forwards to the customer's real emitter once one exists. The two places that actually
 * depend on the real emitter -- `@openfeature/server-sdk` registering its own handlers, and a
 * handler it registered actually firing -- only ever run from code that required
 * `@openfeature/server-sdk` already, so by the time either happens the real emitter is available.
 * Emits that happen before then are silently dropped, which is safe: nothing could have registered
 * a handler yet. `ProviderEvents` defaults to an empty object so the vendored provider's
 * `ProviderEvents.<X>` reads don't throw before then -- the resulting `undefined` event type on an
 * early, handler-less emit is harmless.
 *
 * The `openfeature-server-sdk` instrumentation fills in the real values as soon as it observes the
 * customer requiring `@openfeature/server-sdk` themselves, guaranteeing the vendored provider only
 * ever forwards to that exact instance.
 */

/** @type {typeof import('@openfeature/server-sdk').OpenFeatureEventEmitter | undefined} */
let RealEventEmitter

class DeferredOpenFeatureEventEmitter {
  /** @type {import('@openfeature/server-sdk').OpenFeatureEventEmitter | undefined} */
  #real

  #target () {
    if (!this.#real && RealEventEmitter) {
      this.#real = new RealEventEmitter()
    }
    return this.#real
  }

  /**
   * @param {string} eventType
   * @param {(details?: unknown) => void} handler
   */
  addHandler (eventType, handler) {
    this.#target()?.addHandler(eventType, handler)
  }

  /**
   * @param {string} eventType
   * @param {unknown} [details]
   */
  emit (eventType, details) {
    this.#target()?.emit(eventType, details)
  }
}

module.exports = {
  OpenFeatureEventEmitter: DeferredOpenFeatureEventEmitter,
  /** @type {typeof import('@openfeature/server-sdk').ProviderEvents | Record<string, never>} */
  ProviderEvents: {},
  /** @param {typeof import('@openfeature/server-sdk').OpenFeatureEventEmitter} EventEmitter */
  setEventEmitter (EventEmitter) {
    RealEventEmitter = EventEmitter
  },
}
