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

class OrchestrionDatabaseQueryBridge extends Plugin {
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
      const channels = getOrchestrionChannels(target)
      const options = { allowNoop: true }

      this.addBind(channels.start, context => this.#bindStart(context))
      this.addSub(channels.error, context => this.#publishError(context), options)
      if (target.lifecycle === 'sync') {
        this.addSub(channels.end, context => this.#publishFinish(context), options)
      } else {
        this.addSub(channels.end, context => {
          if (hasError(context)) this.#publishFinish(context)
        }, options)
        this.addSub(channels.asyncEnd, context => this.#publishFinish(context), options)
      }
    }
  }

  /**
   * Normalize a raw package invocation and compose product and APM stores.
   *
   * @param {object} context Raw Orchestrion invocation context.
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
      source: this.#identity,
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

    if (this.#source.updateSource && facts && !facts.skip) {
      try {
        this.#source.updateSource(context, facts)
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
 * @param {Array<{operation: string, adapter: string, source: object}>} definition.operations Database operations.
 * @returns {typeof Plugin} Thin plugin-manager compatibility shell.
 */
function createDatabaseIntegration (definition) {
  const query = validateDefinition(definition)
  const { id, system } = definition
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
    create: runtime => new OrchestrionDatabaseQueryBridge(
      query.source,
      identity,
      sourceRegistry,
      runtime
    ),
  })
  const adapter = Object.freeze({ identity })

  return class DatabaseIntegration extends Plugin {
    static id = id
    static operation = 'query'

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
 * Resolve raw lifecycle channel names for one Orchestrion target.
 *
 * @param {{module: string, name: string}} target Orchestrion target descriptor.
 * @returns {{start: string, end: string, asyncEnd: string, error: string}} Lifecycle channel names.
 */
function getOrchestrionChannels (target) {
  const prefix = `tracing:orchestrion:${target.module}:${target.name}`
  return {
    asyncEnd: `${prefix}:asyncEnd`,
    end: `${prefix}:end`,
    error: `${prefix}:error`,
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
    if (!target || typeof target.module !== 'string' || typeof target.name !== 'string' ||
      (target.lifecycle !== 'sync' && target.lifecycle !== 'async')) {
      throw new TypeError(`Database integration "${definition.id}" has an invalid query target`)
    }

    const key = `${target.module}:${target.name}`
    if (targets.has(key)) {
      throw new TypeError(`Database integration "${definition.id}" repeats query target "${key}"`)
    }
    targets.add(key)
  }

  return query
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
