'use strict'

const { storage } = require('../../../../datadog-core')

const Plugin = require('../../plugins/plugin')
const { getEventDomainRegistry } = require('../registry')
const EventSourceLifecycle = require('../source-lifecycle')
const { getEventSourceRegistry } = require('../source-registry')
const ConnectionLifecycleAdapter = require('./connection-lifecycle-adapter')
const DatabaseProcessor = require('./processor')

const legacyStorage = storage('legacy')
const DATABASE_DOMAIN = DatabaseProcessor.eventDomain
const POOL_ACQUIRE_OPERATION = 'db.pool.acquire'
const QUERY_OPERATION = DatabaseProcessor.eventOperation

class DatabaseQueryBridge extends Plugin {
  #connectionLifecycleAdapter
  #lifecycle

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

    this.#connectionLifecycleAdapter = new ConnectionLifecycleAdapter()
    this.#lifecycle = new EventSourceLifecycle(
      source,
      identity,
      QUERY_OPERATION,
      sourceRegistry,
      runtime,
      'Database'
    )

    if (source.parentChannels) {
      for (const channelName of source.parentChannels) {
        this.addSub(channelName, context => this.#connectionLifecycleAdapter.captureParent(context))
      }
    }

    for (const target of source.targets) {
      const channels = getLifecycleChannels(target)
      const options = { allowNoop: true }

      this.addBind(channels.start, context => {
        const parentStore = context.parentStore ?? legacyStorage.getStore()
        return this.#lifecycle.start(context, parentStore)
      })
      if (channels.restoreParent) {
        this.addBind(channels.finish, context => this.#lifecycle.sourceStore(context), options)
      }
      if (channels.error) {
        this.addSub(channels.error, context => this.#lifecycle.fail(context), options)
      }
      if (channels.errorEnd) {
        this.addSub(channels.errorEnd, context => {
          if (hasError(context)) this.#lifecycle.complete(context)
        }, options)
      }
      this.addSub(channels.finish, context => this.#lifecycle.complete(context), options)
    }
  }
}

class DatabasePoolAcquireBridge extends Plugin {
  #connectionLifecycleAdapter
  #lifecycle

  /**
   * Create the single process-wide bridge for one package pool-acquire source.
   *
   * @param {object} source Package pool-acquire source adapter.
   * @param {object} identity Stable package and database identity.
   * @param {import('../source-registry').EventSourceRegistry} sourceRegistry Process-wide source registry.
   * @param {object} runtime Registered process-wide source runtime.
   */
  constructor (source, identity, sourceRegistry, runtime) {
    super()

    this.#connectionLifecycleAdapter = new ConnectionLifecycleAdapter()
    this.#lifecycle = new EventSourceLifecycle(
      source,
      identity,
      POOL_ACQUIRE_OPERATION,
      sourceRegistry,
      runtime,
      'Database'
    )

    const connection = source.connection
    if (connection) {
      this.addSub(connection.start, context => this.#connectionLifecycleAdapter.start(context))
      this.addBind(connection.finish, context => this.#connectionLifecycleAdapter.finish(context))
      if (connection.skip) {
        this.addBind(connection.skip, () => this.#connectionLifecycleAdapter.skip())
      }
    }

    for (const target of source.targets) {
      const channels = getLifecycleChannels(target)
      const options = { allowNoop: true }

      this.addSub(channels.start, context => {
        this.#lifecycle.start(context, legacyStorage.getStore())
      })
      if (channels.error) {
        this.addSub(channels.error, context => this.#lifecycle.fail(context), options)
      }
      if (channels.errorEnd) {
        this.addSub(channels.errorEnd, context => {
          if (hasError(context)) this.#lifecycle.complete(context)
        }, options)
      }
      this.addSub(channels.finish, context => this.#lifecycle.complete(context), options)
    }
  }
}

/**
 * Compile package database extraction into the shared database processor contract.
 *
 * @param {object} definition Database integration definition.
 * @param {string} definition.id Stable integration identifier.
 * @param {string} definition.system Database system identifier.
 * @param {boolean | string} [definition.schema] Database naming schema identifier, or false for storage defaults.
 * @param {string} [definition.component] Span component override.
 * @param {string} [definition.spanType] Span type override.
 * @param {typeof Plugin} [definition.base] Compatibility plugin base for behavior not yet migrated.
 * @param {Array<{operation: string, adapter: string, source: object}>} definition.operations Database operations.
 * @returns {typeof Plugin} Thin plugin-manager compatibility shell.
 */
function createDatabaseIntegration (definition) {
  const operations = validateDefinition(definition)
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
  const registrations = operations.map(operationDefinition => {
    const { adapter: lifecycle, operation, source } = operationDefinition
    sourceRegistry.registerSource({
      operation,
      source: id,
      owner: `datadog-plugin-${id}`,
      create: runtime => createSourceBridge(
        lifecycle,
        source,
        identity,
        sourceRegistry,
        runtime
      ),
    })

    return Object.freeze({
      adapter: Object.freeze({
        identity,
        lifecycle,
        supportsStatementUpdate: typeof source.updateSource === 'function',
      }),
      operation,
    })
  })

  return class DatabaseIntegration extends Base {
    static id = id
    static operation = 'query'
    static system = system

    #registry
    #sources

    /**
     * Register this tracer as a consumer of the shared database processor.
     *
     * @param {object} tracer Tracer instance.
     * @param {object} tracerConfig Global tracer configuration.
     */
    constructor (tracer, tracerConfig) {
      super(tracer, tracerConfig)

      this.#registry = getEventDomainRegistry(tracer, tracerConfig)
      this.#sources = registrations.map(({ adapter, operation }) => {
        const processor = this.#registry.registerProcessor({
          domain: DATABASE_DOMAIN,
          operation,
          Processor: DatabaseProcessor,
        })
        const runtime = this.#registry.registerSource({ operation, source: id, adapter })

        return {
          consumer: processor.createSourceConsumer(runtime),
          operation,
        }
      })
    }

    /**
     * Suppress a compatibility base's automatic tracing-channel subscriptions.
     *
     * Explicit non-query subscriptions registered by a selected base remain active.
     *
     * @returns {void}
     */
    addTraceSubs () {}

    /**
     * Reference-count physical source bridges and configure immutable per-operation source runtimes.
     *
     * @param {boolean | Record<string, unknown> & {enabled: boolean}} config Plugin configuration.
     * @returns {void}
     */
    configure (config) {
      const enabled = typeof config === 'boolean' ? config : config.enabled !== false

      for (const { consumer, operation } of this.#sources) {
        if (enabled) {
          this.#registry.configureSource(operation, id, config)
          sourceRegistry.acquireSource(operation, id, consumer)
        } else {
          sourceRegistry.releaseSource(operation, id, consumer)
          this.#registry.configureSource(operation, id, config)
        }
      }

      super.configure(config)
    }
  }
}

/**
 * Create the process-wide source bridge selected by a fixed database lifecycle adapter.
 *
 * @param {string} lifecycle Fixed lifecycle adapter identifier.
 * @param {object} source Package source adapter.
 * @param {object} identity Stable package and database identity.
 * @param {import('../source-registry').EventSourceRegistry} sourceRegistry Process-wide source registry.
 * @param {object} runtime Registered process-wide source runtime.
 * @returns {Plugin} Configurable source bridge.
 */
function createSourceBridge (lifecycle, source, identity, sourceRegistry, runtime) {
  if (lifecycle === 'query') {
    return new DatabaseQueryBridge(source, identity, sourceRegistry, runtime)
  }

  return new DatabasePoolAcquireBridge(source, identity, sourceRegistry, runtime)
}

/**
 * Resolve raw lifecycle channel names for one package source target.
 *
 * @param {object} target Package source target descriptor.
 * @returns {{start: string, error?: string, finish: string, errorEnd?: string, restoreParent?: boolean}}
 *   Lifecycle channel names.
 */
function getLifecycleChannels (target) {
  if (target.channels) return { ...target.channels, restoreParent: target.channels.error !== undefined }

  const prefix = `tracing:orchestrion:${target.module}:${target.name}`
  return {
    error: `${prefix}:error`,
    errorEnd: target.lifecycle === 'async' ? `${prefix}:end` : undefined,
    finish: target.lifecycle === 'async' ? `${prefix}:asyncEnd` : `${prefix}:end`,
    start: `${prefix}:start`,
  }
}

/**
 * Validate and resolve supported database operation definitions.
 *
 * @param {object} definition Database integration definition.
 * @returns {Array<{operation: string, adapter: string, source: object}>} Validated operation definitions.
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
  if (!Array.isArray(definition.operations) || definition.operations.length === 0) {
    throw new TypeError(`Database integration "${definition.id}" requires database operations`)
  }

  const operations = new Set()
  for (const operationDefinition of definition.operations) {
    validateOperation(definition.id, operationDefinition)
    if (operations.has(operationDefinition.operation)) {
      throw new TypeError(
        `Database integration "${definition.id}" repeats operation "${operationDefinition.operation}"`
      )
    }
    operations.add(operationDefinition.operation)
  }

  return definition.operations
}

/**
 * Validate one fixed database lifecycle operation.
 *
 * @param {string} id Database integration identifier.
 * @param {object} operationDefinition Possible operation definition.
 * @returns {void}
 */
function validateOperation (id, operationDefinition) {
  const expectedOperation = operationDefinition?.adapter === 'query'
    ? QUERY_OPERATION
    : operationDefinition?.adapter === 'pool.acquire'
      ? POOL_ACQUIRE_OPERATION
      : undefined
  if (!expectedOperation || operationDefinition.operation !== expectedOperation) {
    throw new TypeError(`Database integration "${id}" has an invalid lifecycle adapter`)
  }

  const { source } = operationDefinition
  if (!source || typeof source.start !== 'function' || !Array.isArray(source.targets) ||
    source.targets.length === 0) {
    throw new TypeError(`Database integration "${id}" requires a ${operationDefinition.adapter} source with targets`)
  }
  if (source.parentChannels !== undefined && (!Array.isArray(source.parentChannels) ||
    source.parentChannels.some(channelName => typeof channelName !== 'string' || channelName.length === 0))) {
    throw new TypeError(`Database integration "${id}" has invalid parent channels`)
  }
  if (source.connection !== undefined && !isConnectionLifecycle(source.connection)) {
    throw new TypeError(`Database integration "${id}" has an invalid connection lifecycle`)
  }

  const targets = new Set()
  for (const target of source.targets) {
    const valid = isOrchestrionTarget(target) || isChannelTarget(target, operationDefinition.adapter)
    if (!valid) {
      throw new TypeError(`Database integration "${id}" has an invalid ${operationDefinition.adapter} target`)
    }

    const key = target.channels?.start || `${target.module}:${target.name}`
    if (targets.has(key)) {
      throw new TypeError(`Database integration "${id}" repeats ${operationDefinition.adapter} target "${key}"`)
    }
    targets.add(key)
  }
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
 * @param {string} lifecycle Fixed lifecycle adapter identifier.
 * @returns {boolean} Whether the target is valid.
 */
function isChannelTarget (target, lifecycle) {
  if (target === null || typeof target !== 'object') return false

  const channels = target.channels
  if (channels === null || typeof channels !== 'object' ||
    typeof channels.start !== 'string' || channels.start.length === 0 ||
    typeof channels.finish !== 'string' || channels.finish.length === 0) {
    return false
  }

  return lifecycle !== 'query' || (typeof channels.error === 'string' && channels.error.length > 0)
}

/**
 * Check whether source channels describe connection context restoration.
 *
 * @param {unknown} connection Possible connection lifecycle descriptor.
 * @returns {boolean} Whether the descriptor is valid.
 */
function isConnectionLifecycle (connection) {
  return connection !== null && typeof connection === 'object' &&
    typeof connection.start === 'string' && connection.start.length > 0 &&
    typeof connection.finish === 'string' && connection.finish.length > 0 &&
    (connection.skip === undefined || (typeof connection.skip === 'string' && connection.skip.length > 0))
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

module.exports = createDatabaseIntegration
