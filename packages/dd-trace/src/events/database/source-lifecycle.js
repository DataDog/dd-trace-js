'use strict'

const { storage } = require('../../../../datadog-core')

const log = require('../../log')

const legacyStorage = storage('legacy')

class DatabaseSourceLifecycle {
  #event = Symbol('datadog.database.source.event')
  #identity
  #operation
  #runtime
  #source
  #sourceRegistry

  /**
   * Create shared normalized lifecycle routing for one database operation source.
   *
   * @param {object} source Package source adapter.
   * @param {object} identity Stable package and database identity.
   * @param {string} operation Stable semantic operation identifier.
   * @param {import('../source-registry').EventSourceRegistry} sourceRegistry Process-wide source registry.
   * @param {object} runtime Registered process-wide source runtime.
   */
  constructor (source, identity, operation, sourceRegistry, runtime) {
    this.#identity = identity
    this.#operation = operation
    this.#runtime = runtime
    this.#source = source
    this.#sourceRegistry = sourceRegistry
  }

  /**
   * Normalize a raw package invocation and start every eligible lifecycle consumer.
   *
   * @param {object} context Raw package lifecycle context.
   * @param {object | undefined} parentStore Store owned by the package caller.
   * @returns {object | undefined} Store active while the package operation runs.
   */
  start (context, parentStore) {
    let facts
    try {
      facts = this.#source.start(context)
    } catch (error) {
      log.error('Database source "%s" failed during start: %s', this.#identity.integration, error?.message || error)
      return parentStore
    }

    const runtime = this.#runtime
    const hasContributors = runtime.contributors.size > 0
    const singleConsumer = runtime.consumers.size === 1 ? runtime.primaryConsumer : undefined
    const event = {
      consumer: singleConsumer,
      currentStore: undefined,
      facts,
      parentStore,
      primaryConsumer: runtime.primaryConsumer,
      source: this.#identity,
      sourceStore: parentStore,
    }
    context[this.#event] = event
    this.#sourceRegistry.holdOperation(runtime)

    let store = parentStore
    if (hasContributors) {
      const productEvent = {
        facts,
        source: this.#identity,
      }
      event.productLifecycle = this.#sourceRegistry.startContributors(
        this.#operation,
        productEvent,
        parentStore
      )
      store = event.productLifecycle?.store ?? store
    }

    if (singleConsumer) {
      store = !hasContributors || store === legacyStorage.getStore()
        ? singleConsumer.start(event)
        : legacyStorage.run(store, bindProcessorStart, singleConsumer, event)
    } else {
      for (const consumer of runtime.consumers) {
        store = store === legacyStorage.getStore()
          ? consumer.start(event)
          : legacyStorage.run(store, bindProcessorStart, consumer, event)
        rememberConsumer(event, consumer)
      }
    }

    if (this.#source.updateSource && event.updates) {
      try {
        this.#source.updateSource(context, facts, event.updates)
      } catch (error) {
        log.error(
          'Database source "%s" failed during source update: %s',
          this.#identity.integration,
          error?.message || error
        )
      }
    }

    return store
  }

  /**
   * Publish one normalized error phase while retaining state for completion.
   *
   * @param {object} context Raw package lifecycle context.
   * @returns {void}
   */
  fail (context) {
    const event = context[this.#event]
    if (!event || Object.hasOwn(event, 'error')) return

    event.error = context.error
    this.#resolveMetadata(context, event)
    const productLifecycle = event.productLifecycle
    if (productLifecycle) {
      productLifecycle.event.error = event.error
      productLifecycle.event.metadata = event.metadata
      this.#sourceRegistry.runContributorPhase(productLifecycle, 'error')
    }
    if (event.consumers) {
      for (const consumer of event.consumers) consumer.fail(event)
    } else {
      event.consumer?.fail(event)
    }
  }

  /**
   * Publish one normalized terminal phase and release raw-context correlation state.
   *
   * @param {object} context Raw package lifecycle context.
   * @returns {void}
   */
  complete (context) {
    const event = context[this.#event]
    if (!event) return

    if (hasError(context) && !Object.hasOwn(event, 'error')) this.fail(context)
    this.#resolveMetadata(context, event)
    const productLifecycle = event.productLifecycle
    if (productLifecycle) {
      productLifecycle.event.metadata = event.metadata
      this.#sourceRegistry.runContributorPhase(productLifecycle, 'finish')
    }

    try {
      if (event.consumers) {
        for (const consumer of event.consumers) consumer.complete(event)
      } else {
        event.consumer?.complete(event)
      }
    } finally {
      context[this.#event] = undefined
      this.#sourceRegistry.releaseOperation(this.#runtime)
    }
  }

  /**
   * Resolve the store captured when the operation started.
   *
   * @param {object} context Raw package lifecycle context.
   * @returns {object | undefined} Source caller store.
   */
  sourceStore (context) {
    return context[this.#event]?.sourceStore
  }

  /**
   * Extract completion metadata once while isolating package-specific failures.
   *
   * @param {object} context Raw package lifecycle context.
   * @param {object} event Normalized semantic database event.
   * @returns {void}
   */
  #resolveMetadata (context, event) {
    if (Object.hasOwn(event, 'metadata')) return

    try {
      event.metadata = this.#source.complete?.(context)
    } catch (error) {
      log.error(
        'Database source "%s" failed during completion: %s',
        this.#identity.integration,
        error?.message || error
      )
    }
  }
}

/**
 * Start one processor inside the store composed by earlier lifecycle consumers.
 *
 * @param {object} consumer Stable source consumer with a per-tracer database processor.
 * @param {object} event Normalized database event shared across lifecycle phases.
 * @returns {object | undefined} Store returned by the processor.
 */
function bindProcessorStart (consumer, event) {
  return consumer.start(event)
}

/**
 * Preserve processors which started an operation so disablement cannot orphan its terminal phase.
 *
 * @param {object} event Normalized database event shared across lifecycle phases.
 * @param {object} consumer Stable source consumer which started tracing.
 * @returns {void}
 */
function rememberConsumer (event, consumer) {
  if (event.consumer) {
    event.consumers ||= [event.consumer]
    event.consumers.push(consumer)
  } else {
    event.consumer = consumer
  }
}

/**
 * Check whether a terminal context carries an application error.
 *
 * @param {unknown} context Possible lifecycle context.
 * @returns {context is object} Whether the context has an error value.
 */
function hasError (context) {
  return context !== null && typeof context === 'object' && Reflect.get(context, 'error') !== undefined
}

module.exports = DatabaseSourceLifecycle
