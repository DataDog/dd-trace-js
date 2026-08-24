'use strict'

const { storage } = require('../../../../datadog-core')

const log = require('../../log')
const Plugin = require('../../plugins/plugin')
const { getEventDomainRegistry } = require('../registry')
const { getEventSourceRegistry } = require('../source-registry')
const DatabaseProcessor = require('./processor')

const legacyStorage = storage('legacy')
const QUERY_OPERATION = DatabaseProcessor.eventOperation
const queryEvent = Symbol('datadog.database.query.event')

class DatabaseQueryBridge extends Plugin {
  #identity
  #runtime
  #source
  #sourceRegistry

  /**
   * Create the single process-wide bridge for one package query source.
   *
   * @param {object} source Package query source adapter.
   * @param {object} identity Stable package and database identity.
   * @param {import('../source-registry').EventSourceRegistry} sourceRegistry Process-wide source registry.
   * @param {object} runtime Registered process-wide source runtime.
   */
  constructor (source, identity, sourceRegistry, runtime) {
    super()

    this.#identity = identity
    this.#runtime = runtime
    this.#source = source
    this.#sourceRegistry = sourceRegistry

    for (const target of source.targets) {
      const channels = getLifecycleChannels(target)
      const options = { allowNoop: true }

      this.addBind(channels.start, context => this.#bindStart(context))
      if (channels.restoreParent) {
        this.addBind(channels.finish, context => this.#bindFinish(context), options)
      }
      this.addSub(channels.error, context => this.#publishError(context), options)
      if (channels.errorEnd) {
        this.addSub(channels.errorEnd, context => {
          if (hasError(context)) this.#publishFinish(context)
        }, options)
      }
      this.addSub(channels.finish, context => this.#publishFinish(context), options)
    }
  }

  /**
   * Restore the source caller's store around a driver-owned completion callback.
   *
   * @param {object} context Raw package lifecycle context.
   * @returns {object | undefined} Store captured when the query started.
   */
  #bindFinish (context) {
    return context[queryEvent]?.sourceStore
  }

  /**
   * Normalize a raw package invocation and compose product and APM stores.
   *
   * @param {object} context Raw package lifecycle context.
   * @returns {object | undefined} Store active while the package operation runs.
   */
  #bindStart (context) {
    const parentStore = legacyStorage.getStore()
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
    context[queryEvent] = event
    this.#sourceRegistry.holdOperation(runtime)

    let store = parentStore
    if (hasContributors) {
      const productEvent = {
        facts,
        source: this.#identity,
      }
      event.productLifecycle = this.#sourceRegistry.startContributors(
        QUERY_OPERATION,
        productEvent,
        parentStore
      )
      store = event.productLifecycle?.store ?? store
    }

    if (singleConsumer) {
      const consumer = singleConsumer
      store = !hasContributors || store === legacyStorage.getStore()
        ? consumer.start(event)
        : legacyStorage.run(store, bindProcessorStart, consumer, event)
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
   * Publish one normalized error phase and preserve state for the final completion phase.
   *
   * @param {object} context Raw Orchestrion invocation context.
   * @returns {void}
   */
  #publishError (context) {
    const event = context[queryEvent]
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
   * Publish one normalized finish phase and release all raw-context correlation state.
   *
   * @param {object} context Raw Orchestrion invocation context.
   * @returns {void}
   */
  #publishFinish (context) {
    const event = context[queryEvent]
    if (!event) return

    if (context.error !== undefined && !Object.hasOwn(event, 'error')) this.#publishError(context)
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
      context[queryEvent] = undefined
      this.#sourceRegistry.releaseOperation(this.#runtime)
    }
  }

  /**
   * Extract completion metadata once while isolating package-specific failures.
   *
   * @param {object} context Raw Orchestrion invocation context.
   * @param {object} event Normalized semantic query event.
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
 * Compile package query extraction into the shared database processor contract.
 *
 * @param {object} definition Database integration definition.
 * @param {string} definition.id Stable integration identifier.
 * @param {string} definition.system Database system identifier.
 * @param {boolean | string} [definition.schema] Database naming schema identifier, or false for storage defaults.
 * @param {string} [definition.component] Span component override.
 * @param {string} [definition.spanType] Span type override.
 * @param {typeof Plugin} [definition.base] Compatibility plugin base for non-query behavior.
 * @param {Array<{operation: string, adapter: string, source: object}>} definition.operations Database operations.
 * @returns {typeof Plugin} Thin plugin-manager compatibility shell.
 */
function createDatabaseIntegration (definition) {
  const query = validateDefinition(definition)
  const { id, system } = definition
  const Base = definition.base || Plugin
  const sourceRegistry = getEventSourceRegistry()
  const identity = Object.freeze({
    component: definition.component,
    integration: id,
    schema: definition.schema,
    spanType: definition.spanType,
    system,
  })
  sourceRegistry.registerSource({
    operation: QUERY_OPERATION,
    source: id,
    owner: `datadog-plugin-${id}`,
    create: runtime => new DatabaseQueryBridge(
      query.source,
      identity,
      sourceRegistry,
      runtime
    ),
  })
  const adapter = Object.freeze({
    identity,
    supportsStatementUpdate: typeof query.source.updateSource === 'function',
  })

  return class DatabaseIntegration extends Base {
    static id = id
    static operation = 'query'
    static system = system

    #consumer
    #registry

    /**
     * Register this tracer as a consumer of the shared database query processor.
     *
     * @param {object} tracer Tracer instance.
     * @param {object} tracerConfig Global tracer configuration.
     */
    constructor (tracer, tracerConfig) {
      super(tracer, tracerConfig)

      this.#registry = getEventDomainRegistry(tracer, tracerConfig)
      const processor = this.#registry.registerProcessor({ operation: QUERY_OPERATION, Processor: DatabaseProcessor })
      const runtime = this.#registry.registerSource({ operation: QUERY_OPERATION, source: id, adapter })
      this.#consumer = processor.createSourceConsumer(runtime)
    }

    /**
     * Suppress the compatibility base's automatic query subscriptions.
     *
     * Non-query subscriptions registered explicitly by the selected base remain active.
     *
     * @returns {void}
     */
    addTraceSubs () {}

    /**
     * Reference-count the physical source bridge and configure this tracer's immutable source runtime.
     *
     * @param {boolean | Record<string, unknown> & {enabled: boolean}} config Plugin configuration.
     * @returns {void}
     */
    configure (config) {
      const enabled = typeof config === 'boolean' ? config : config.enabled !== false

      if (enabled) {
        this.#registry.configureSource(QUERY_OPERATION, id, config)
        sourceRegistry.acquireSource(QUERY_OPERATION, id, this.#consumer)
      } else {
        sourceRegistry.releaseSource(QUERY_OPERATION, id, this.#consumer)
        this.#registry.configureSource(QUERY_OPERATION, id, config)
      }

      super.configure(config)
    }
  }
}

/**
 * Resolve raw lifecycle channel names for one package source target.
 *
 * @param {object} target Package source target descriptor.
 * @returns {{start: string, error: string, finish: string, errorEnd?: string, restoreParent?: boolean}}
 *   Lifecycle channel names.
 */
function getLifecycleChannels (target) {
  if (target.channels) return { ...target.channels, restoreParent: true }

  const prefix = `tracing:orchestrion:${target.module}:${target.name}`
  return {
    error: `${prefix}:error`,
    errorEnd: target.lifecycle === 'async' ? `${prefix}:end` : undefined,
    finish: target.lifecycle === 'async' ? `${prefix}:asyncEnd` : `${prefix}:end`,
    start: `${prefix}:start`,
  }
}

/**
 * Check whether an Orchestrion terminal context carries an application error.
 *
 * @param {unknown} context Possible Orchestrion invocation context.
 * @returns {context is object} Whether the context has an error value.
 */
function hasError (context) {
  return context !== null && typeof context === 'object' && Reflect.get(context, 'error') !== undefined
}

/**
 * Validate and resolve the currently supported database query definition.
 *
 * @param {object} definition Database integration definition.
 * @returns {{operation: string, adapter: string, source: object}} Query operation definition.
 */
function validateDefinition (definition) {
  if (!definition || typeof definition.id !== 'string' || definition.id.length === 0) {
    throw new TypeError('Database integration requires a non-empty id')
  }
  if (typeof definition.system !== 'string' || definition.system.length === 0) {
    throw new TypeError(`Database integration "${definition.id}" requires a non-empty system`)
  }
  if (definition.base !== undefined && (typeof definition.base !== 'function' ||
    (definition.base !== Plugin && !(definition.base.prototype instanceof Plugin)))) {
    throw new TypeError(`Database integration "${definition.id}" requires a Plugin base`)
  }
  if (!Array.isArray(definition.operations) || definition.operations.length !== 1) {
    throw new TypeError(`Database integration "${definition.id}" requires one query operation`)
  }

  const query = definition.operations[0]
  if (query.operation !== QUERY_OPERATION || query.adapter !== 'query') {
    throw new TypeError(`Database integration "${definition.id}" requires the db.query adapter`)
  }
  if (!query.source || typeof query.source.start !== 'function' || !Array.isArray(query.source.targets) ||
    query.source.targets.length === 0) {
    throw new TypeError(`Database integration "${definition.id}" requires a query source with targets`)
  }

  const targets = new Set()
  for (const target of query.source.targets) {
    if (!isOrchestrionTarget(target) && !isChannelTarget(target)) {
      throw new TypeError(`Database integration "${definition.id}" has an invalid query target`)
    }

    const key = target.channels?.start || `${target.module}:${target.name}`
    if (targets.has(key)) {
      throw new TypeError(`Database integration "${definition.id}" repeats query target "${key}"`)
    }
    targets.add(key)
  }

  return query
}

/**
 * Check whether a target describes an Orchestrion function lifecycle.
 *
 * @param {unknown} target Possible target descriptor.
 * @returns {boolean} Whether the target is valid.
 */
function isOrchestrionTarget (target) {
  return target !== null && typeof target === 'object' &&
    target.channels === undefined &&
    typeof target.module === 'string' && target.module.length > 0 &&
    typeof target.name === 'string' && target.name.length > 0 &&
    (target.lifecycle === 'sync' || target.lifecycle === 'async')
}

/**
 * Check whether a target describes an existing diagnostic-channel lifecycle.
 *
 * @param {unknown} target Possible target descriptor.
 * @returns {boolean} Whether the target is valid.
 */
function isChannelTarget (target) {
  if (target === null || typeof target !== 'object') return false

  const channels = target.channels
  return channels !== null && typeof channels === 'object' &&
    typeof channels.start === 'string' && channels.start.length > 0 &&
    typeof channels.error === 'string' && channels.error.length > 0 &&
    typeof channels.finish === 'string' && channels.finish.length > 0
}

/**
 * Start one processor inside the store composed by earlier lifecycle consumers.
 *
 * @param {object} consumer Stable source consumer with a per-tracer database processor.
 * @param {object} event Normalized query event shared across lifecycle phases.
 * @returns {object | undefined} Store returned by the processor.
 */
function bindProcessorStart (consumer, event) {
  return consumer.start(event)
}

/**
 * Preserve the processors which started an operation so disablement cannot orphan its terminal phase.
 *
 * @param {object} event Normalized query event shared across lifecycle phases.
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

module.exports = createDatabaseIntegration
