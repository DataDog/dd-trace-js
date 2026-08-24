'use strict'

const registries = new WeakMap()

/**
 * @typedef {object} EventProcessor
 * @property {(config: {enabled: boolean}) => void} configure
 */

class EventDomainRegistry {
  #domains = new Map()
  #tracer
  #tracerConfig

  /**
   * Create an event domain registry for one tracer instance.
   *
   * @param {object} tracer Tracer instance shared by event domain processors.
   * @param {object} tracerConfig Global tracer configuration.
   */
  constructor (tracer, tracerConfig) {
    this.#tracer = tracer
    this.#tracerConfig = tracerConfig
  }

  /**
   * Register or resolve the single processor that owns a semantic operation.
   *
   * @template {EventProcessor} ProcessorType
   * @param {object} definition Processor definition.
   * @param {string} definition.operation Stable semantic operation identifier.
   * @param {new (tracer: object, tracerConfig: object, registry: EventDomainRegistry) => ProcessorType}
   *   definition.Processor Processor constructor.
   * @returns {ProcessorType} Processor instance owned by this registry.
   */
  registerProcessor ({ operation, Processor }) {
    const domain = this.#domains.get(operation)

    if (domain) {
      if (domain.Processor !== Processor) {
        throw new Error(`Processor already registered for operation "${operation}"`)
      }

      return domain.processor
    }

    const processor = new Processor(this.#tracer, this.#tracerConfig, this)
    this.#domains.set(operation, {
      Processor,
      processor,
      enabledSourceCount: 0,
      sources: new Map(),
    })

    return processor
  }

  /**
   * Register the package adapter responsible for one semantic operation source.
   *
   * @param {object} definition Source definition.
   * @param {string} definition.operation Stable semantic operation identifier.
   * @param {string} definition.source Stable package or platform source identifier.
   * @param {object} definition.adapter Source adapter.
   * @returns {object} Stable source runtime used by the processor hot path.
   */
  registerSource ({ operation, source, adapter }) {
    const domain = this.#getDomain(operation)

    const existing = domain.sources.get(source)
    if (existing) {
      if (existing.adapter === adapter) return existing

      throw new Error(`Source "${source}" already registered for operation "${operation}"`)
    }

    const runtime = {
      adapter,
      config: undefined,
      enabled: false,
      operation,
      source,
    }
    domain.sources.set(source, runtime)

    return runtime
  }

  /**
   * Update one source without changing processor ownership or configuration for sibling sources.
   *
   * Configuration is copied and frozen so later caller mutation cannot change operation behavior.
   *
   * @param {string} operation Stable semantic operation identifier.
   * @param {string} source Stable package or platform source identifier.
   * @param {boolean | Record<string, unknown>} config Package-specific configuration.
   * @returns {void}
   */
  configureSource (operation, source, config) {
    const domain = this.#getDomain(operation)
    const runtime = this.#getSource(domain, operation, source)
    const enabled = typeof config === 'boolean' ? config : config?.enabled !== false

    runtime.config = Object.freeze(typeof config === 'boolean' ? { enabled: config } : { ...config })
    if (runtime.enabled === enabled) return

    runtime.enabled = enabled
    if (enabled) {
      domain.enabledSourceCount++
      if (domain.enabledSourceCount === 1) {
        domain.processor.configure({ enabled: true })
      }
      return
    }

    domain.enabledSourceCount--
    if (domain.enabledSourceCount === 0) {
      domain.processor.configure({ enabled: false })
    }
  }

  /**
   * Resolve an enabled source runtime without allocating on the operation path.
   *
   * @param {string} operation Stable semantic operation identifier.
   * @param {string} source Stable package or platform source identifier.
   * @returns {object | undefined} Enabled source runtime.
   */
  getSource (operation, source) {
    const runtime = this.#domains.get(operation)?.sources.get(source)

    return runtime?.enabled ? runtime : undefined
  }

  /**
   * Disable every processor owned by this registry.
   *
   * @returns {void}
   */
  destroy () {
    for (const domain of this.#domains.values()) {
      if (domain.enabledSourceCount > 0) {
        domain.processor.configure({ enabled: false })
      }
    }
    this.#domains.clear()
  }

  /**
   * Resolve a registered semantic operation.
   *
   * @param {string} operation Stable semantic operation identifier.
   * @returns {object} Registered operation domain.
   */
  #getDomain (operation) {
    const domain = this.#domains.get(operation)
    if (!domain) {
      throw new Error(`No processor registered for operation "${operation}"`)
    }

    return domain
  }

  /**
   * Resolve a registered source from an operation domain.
   *
   * @param {object} domain Registered operation domain.
   * @param {string} operation Stable semantic operation identifier.
   * @param {string} source Stable package or platform source identifier.
   * @returns {object} Stable source runtime.
   */
  #getSource (domain, operation, source) {
    const runtime = domain.sources.get(source)
    if (!runtime) {
      throw new Error(`No source "${source}" registered for operation "${operation}"`)
    }

    return runtime
  }
}

/**
 * Resolve the event domain registry owned by one tracer instance.
 *
 * @param {object} tracer Tracer instance used as the registry owner.
 * @param {object} tracerConfig Global tracer configuration.
 * @returns {EventDomainRegistry} Per-tracer event domain registry.
 */
function getEventDomainRegistry (tracer, tracerConfig) {
  let registry = registries.get(tracer)
  if (!registry) {
    registry = new EventDomainRegistry(tracer, tracerConfig)
    registries.set(tracer, registry)
  }

  return registry
}

module.exports = {
  EventDomainRegistry,
  getEventDomainRegistry,
}
