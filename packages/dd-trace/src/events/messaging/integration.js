'use strict'

const { storage } = require('../../../../datadog-core')

const Plugin = require('../../plugins/plugin')
const { getEventDomainRegistry } = require('../registry')
const EventSourceLifecycle = require('../source-lifecycle')
const { getEventSourceRegistry } = require('../source-registry')
const MessagingProcessor = require('./processor')

const legacyStorage = storage('legacy')
const CONSUME_OPERATION = 'messaging.consume'
const MESSAGING_DOMAIN = MessagingProcessor.eventDomain
const PRODUCE_OPERATION = MessagingProcessor.eventOperation

class MessagingSourceBridge extends Plugin {
  /**
   * Create the single process-wide bridge for one package messaging source.
   *
   * @param {object} source Package messaging source adapter.
   * @param {object} identity Stable package and messaging identity.
   * @param {string} operation Stable semantic messaging operation.
   * @param {import('../source-registry').EventSourceRegistry} sourceRegistry Process-wide source registry.
   * @param {object} runtime Registered process-wide source runtime.
   */
  constructor (source, identity, operation, sourceRegistry, runtime) {
    super()

    for (const target of source.targets) {
      const lifecycle = new EventSourceLifecycle(target, identity, operation, sourceRegistry, runtime, 'Messaging')
      const channels = getLifecycleChannels(target)
      const completionOptions = { allowNoop: true }

      this.addBind(channels.start, context => lifecycle.start(context, legacyStorage.getStore()))
      this.addSub(channels.error, context => lifecycle.fail(context), completionOptions)
      if (target.lifecycle === 'async') {
        this.addSub(channels.end, context => {
          if (hasError(context)) lifecycle.complete(context)
        }, completionOptions)
        this.addSub(channels.asyncEnd, context => lifecycle.complete(context), completionOptions)
      } else {
        this.addSub(channels.end, context => lifecycle.complete(context), completionOptions)
      }
    }
  }
}

/**
 * Compile package messaging extraction into the shared messaging processor contract.
 *
 * @param {object} definition Messaging integration definition.
 * @param {string} definition.id Stable integration identifier.
 * @param {string} [definition.system] Messaging system identifier.
 * @param {string} [definition.component] Span component override.
 * @param {(config: object) => object} [definition.configure] Source configuration mapper.
 * @param {Array<{operation: string, adapter: string, source: object}>} definition.operations Messaging operations.
 * @returns {typeof Plugin} Thin plugin-manager compatibility shell.
 */
function createMessagingIntegration (definition) {
  const operations = validateDefinition(definition)
  const { id } = definition
  const sourceRegistry = getEventSourceRegistry()
  const identity = Object.freeze({
    component: definition.component,
    integration: id,
    system: definition.system || id,
  })
  const registrations = operations.map(operationDefinition => {
    const { adapter: lifecycle, operation, source } = operationDefinition
    sourceRegistry.registerSource({
      operation,
      source: id,
      owner: `datadog-plugin-${id}`,
      create: runtime => new MessagingSourceBridge(source, identity, operation, sourceRegistry, runtime),
    })

    return Object.freeze({
      adapter: Object.freeze({ identity, lifecycle }),
      operation,
    })
  })

  return class MessagingIntegration extends Plugin {
    static id = id
    static operation = id

    #registry
    #sources

    /**
     * Register this tracer as a consumer of the shared messaging processor.
     *
     * @param {object} tracer Tracer instance.
     * @param {object} tracerConfig Global tracer configuration.
     */
    constructor (tracer, tracerConfig) {
      super(tracer, tracerConfig)

      this.#registry = getEventDomainRegistry(tracer, tracerConfig)
      this.#sources = registrations.map(({ adapter, operation }) => {
        const processor = this.#registry.registerProcessor({
          domain: MESSAGING_DOMAIN,
          operation,
          Processor: MessagingProcessor,
        })
        const runtime = this.#registry.registerSource({ operation, source: id, adapter })

        return {
          consumer: processor.createSourceConsumer(runtime),
          operation,
        }
      })
    }

    /**
     * Reference-count physical source bridges and configure immutable per-operation runtimes.
     *
     * @param {boolean | Record<string, unknown> & {enabled: boolean}} config Plugin configuration.
     * @returns {void}
     */
    configure (config) {
      if (typeof config !== 'boolean' && definition.configure) config = definition.configure(config)
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
 * Resolve Orchestrion lifecycle channel names for one package source target.
 *
 * @param {object} target Package source target descriptor.
 * @returns {{start: string, end: string, asyncEnd: string, error: string}} Lifecycle channel names.
 */
function getLifecycleChannels (target) {
  const prefix = `tracing:orchestrion:${target.module}:${target.name}`
  return {
    asyncEnd: `${prefix}:asyncEnd`,
    end: `${prefix}:end`,
    error: `${prefix}:error`,
    start: `${prefix}:start`,
  }
}

/**
 * Validate and resolve supported messaging operation definitions.
 *
 * @param {object} definition Messaging integration definition.
 * @returns {Array<{operation: string, adapter: string, source: object}>} Validated operation definitions.
 */
function validateDefinition (definition) {
  if (!definition || typeof definition.id !== 'string' || definition.id.length === 0) {
    throw new TypeError('Messaging integration requires a non-empty id')
  }
  if (definition.system !== undefined && (typeof definition.system !== 'string' || definition.system.length === 0)) {
    throw new TypeError(`Messaging integration "${definition.id}" requires a non-empty system`)
  }
  if (definition.configure !== undefined && typeof definition.configure !== 'function') {
    throw new TypeError(`Messaging integration "${definition.id}" requires a configuration mapper`)
  }
  if (!Array.isArray(definition.operations) || definition.operations.length === 0) {
    throw new TypeError(`Messaging integration "${definition.id}" requires messaging operations`)
  }

  const operations = new Set()
  for (const operationDefinition of definition.operations) {
    validateOperation(definition.id, operationDefinition)
    if (operations.has(operationDefinition.operation)) {
      throw new TypeError(
        `Messaging integration "${definition.id}" repeats operation "${operationDefinition.operation}"`
      )
    }
    operations.add(operationDefinition.operation)
  }

  return definition.operations
}

/**
 * Validate one fixed messaging lifecycle operation.
 *
 * @param {string} id Messaging integration identifier.
 * @param {object} operationDefinition Possible operation definition.
 * @returns {void}
 */
function validateOperation (id, operationDefinition) {
  const expectedOperation = operationDefinition?.adapter === 'produce'
    ? PRODUCE_OPERATION
    : operationDefinition?.adapter === 'consume'
      ? CONSUME_OPERATION
      : undefined
  if (!expectedOperation || operationDefinition.operation !== expectedOperation) {
    throw new TypeError(`Messaging integration "${id}" has an invalid lifecycle adapter`)
  }

  const { source } = operationDefinition
  if (!source || !Array.isArray(source.targets) || source.targets.length === 0) {
    throw new TypeError(`Messaging integration "${id}" requires a ${operationDefinition.adapter} source with targets`)
  }

  const targets = new Set()
  for (const target of source.targets) {
    if (!isSourceTarget(target)) {
      throw new TypeError(`Messaging integration "${id}" has an invalid ${operationDefinition.adapter} target`)
    }
    const key = `${target.module}:${target.name}`
    if (targets.has(key)) {
      throw new TypeError(
        `Messaging integration "${id}" repeats ${operationDefinition.adapter} target "${key}"`
      )
    }
    targets.add(key)
  }
}

/**
 * Check whether a target describes an Orchestrion messaging lifecycle and its package source extraction.
 *
 * @param {unknown} target Possible target descriptor.
 * @returns {boolean} Whether the target is valid.
 */
function isSourceTarget (target) {
  return target !== null && typeof target === 'object' &&
    typeof target.module === 'string' && target.module.length > 0 &&
    typeof target.name === 'string' && target.name.length > 0 &&
    (target.lifecycle === 'sync' || target.lifecycle === 'async') &&
    typeof target.start === 'function' &&
    (target.complete === undefined || typeof target.complete === 'function') &&
    (target.updateSource === undefined || typeof target.updateSource === 'function')
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

module.exports = createMessagingIntegration
