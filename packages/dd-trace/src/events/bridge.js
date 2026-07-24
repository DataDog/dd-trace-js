'use strict'

const { storage } = require('../../../datadog-core')

const { getEventSourceRegistry } = require('./source-registry')

const legacyStorage = storage('legacy')

/**
 * Bridge one package-scoped source lifecycle into a shared semantic lifecycle.
 *
 * Package adapters own source-phase mapping. For example, a synchronous source
 * can call `finish()` from `end`, while Promise and callback sources normally
 * call it from `asyncEnd`. Adapters with custom completion boundaries can call
 * it from a callback, EventEmitter, stream, or command completion hook.
 */
class SemanticLifecycleBridge {
  /**
   * @param {object} definition Bridge definition.
   * @param {string} definition.operation Stable semantic operation identifier.
   * @param {{
   *   start: import('diagnostics_channel').Channel,
   *   error: import('diagnostics_channel').Channel,
   *   finish: import('diagnostics_channel').Channel
   * }} definition.channels Semantic start/error/finish channels.
   * @param {(context: object) => object} definition.normalize In-place source normalizer.
   * @param {(event: object) => boolean} [definition.shouldPublishSemantic]
   * Whether this source context should enter the shared semantic processor.
   * @param {import('./source-registry').EventSourceRegistry} [definition.sourceRegistry]
   */
  constructor ({
    operation,
    channels,
    normalize,
    shouldPublishSemantic = alwaysPublish,
    sourceRegistry = getEventSourceRegistry(),
  }) {
    if (!operation) throw new Error('Semantic lifecycle bridge requires an operation')
    if (!channels?.start || !channels?.error || !channels?.finish) {
      throw new Error(`Semantic lifecycle bridge "${operation}" requires start, error, and finish channels`)
    }
    if (typeof normalize !== 'function') {
      throw new TypeError(`Semantic lifecycle bridge "${operation}" requires a normalizer`)
    }
    if (typeof shouldPublishSemantic !== 'function') {
      throw new TypeError(`Semantic lifecycle bridge "${operation}" requires a semantic publication predicate`)
    }

    this._operation = operation
    this._channels = channels
    this._normalize = normalize
    this._shouldPublishSemantic = shouldPublishSemantic
    this._sourceRegistry = sourceRegistry
    this._state = Symbol(`datadog.event.bridge.${operation}`)
  }

  /**
   * Normalize a source context, compose product contributors, and enter the
   * semantic processor store around the instrumented operation.
   *
   * @param {object} context Package-scoped source context.
   * @returns {object|undefined} Store to bind around the source operation.
   */
  start (context) {
    assertContext(context, this._operation)

    const existing = context[this._state]
    if (existing) return existing.store

    const event = this._normalize(context)
    if (!event || typeof event !== 'object') {
      throw new TypeError(`Semantic lifecycle bridge "${this._operation}" normalizer must return an event object`)
    }

    const parentStore = legacyStorage.getStore()
    const state = {
      contributorStore: parentStore,
      errorPublished: false,
      event,
      finished: false,
      parentStore,
      publishSemantic: this._shouldPublishSemantic(event),
      store: parentStore,
    }
    context[this._state] = state
    event.parentStore ??= parentStore

    state.contributorStore = this._sourceRegistry.runContributors(
      this._operation,
      'start',
      event,
      parentStore
    )

    state.store = state.publishSemantic
      ? legacyStorage.run(
        state.contributorStore,
        () => this._channels.start.runStores(event, getStore)
      )
      : state.contributorStore

    return state.store
  }

  /**
   * Publish one semantic error without completing the operation.
   *
   * @param {object} context Package-scoped source context passed to `start()`.
   * @returns {void}
   */
  error (context) {
    const state = this._getState(context)
    if (!state || state.finished || state.errorPublished) return

    state.errorPublished = true
    state.contributorStore = this._sourceRegistry.runContributors(
      this._operation,
      'error',
      state.event,
      state.contributorStore
    )
    this._publish(this._channels.error, state)
  }

  /**
   * Publish semantic completion exactly once and return the product contributor
   * store that package adapters can restore around user callbacks.
   *
   * @param {object} context Package-scoped source context passed to `start()`.
   * @returns {object|undefined} Store to restore after operation completion.
   */
  finish (context) {
    const state = this._getState(context)
    if (!state) return
    if (state.finished) return state.contributorStore

    state.finished = true
    state.contributorStore = this._sourceRegistry.runContributors(
      this._operation,
      'finish',
      state.event,
      state.contributorStore
    )
    this._publish(this._channels.finish, state)

    return state.contributorStore
  }

  /**
   * Resolve state for an operation context.
   *
   * @param {object} context Package-scoped source context.
   * @returns {object|undefined} Bridge state.
   */
  _getState (context) {
    if (!context || typeof context !== 'object') return

    return context[this._state]
  }

  /**
   * Publish a semantic phase under the operation store established at start.
   *
   * @param {import('diagnostics_channel').Channel} channel Semantic phase channel.
   * @param {object} state Active bridge state.
   * @returns {void}
   */
  _publish (channel, state) {
    if (!state.publishSemantic) return

    legacyStorage.run(state.store, () => channel.publish(state.event))
  }
}

/**
 * @param {unknown} context Source context.
 * @param {string} operation Semantic operation identifier.
 * @returns {void}
 */
function assertContext (context, operation) {
  if (!context || typeof context !== 'object') {
    throw new TypeError(`Semantic lifecycle bridge "${operation}" requires an object context`)
  }
}

/**
 * Return the store active after semantic start bindings run.
 *
 * @returns {object|undefined} Active legacy storage store.
 */
function getStore () {
  return legacyStorage.getStore()
}

/**
 * Publish every normalized source event to its semantic processor by default.
 *
 * @returns {true} Semantic publication is enabled.
 */
function alwaysPublish () {
  return true
}

module.exports = { SemanticLifecycleBridge }
