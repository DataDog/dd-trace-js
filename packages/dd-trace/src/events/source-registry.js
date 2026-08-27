'use strict'

const log = require('../log')

class EventSourceRegistry {
  #operations = new Map()

  /**
   * Register a lazily-created package bridge for one semantic operation.
   *
   * Repeating a registration from the same owner is idempotent. A different owner cannot replace the source bridge.
   *
   * @param {object} definition Source bridge definition.
   * @param {string} definition.operation Stable semantic operation identifier.
   * @param {string} definition.source Stable package or platform source identifier.
   * @param {string} definition.owner Stable module owning the source key.
   * @param {(runtime: object) => {configure: (config: {enabled: boolean}) => void}}
   *   definition.create Source bridge factory.
   * @returns {object} Stable source bridge runtime.
   */
  registerSource ({ operation, source, owner, create }) {
    if (!owner) {
      throw new Error(`Source "${source}" requires an owner for operation "${operation}"`)
    }

    const operationRuntime = this.#getOperation(operation, true)
    const existing = operationRuntime.sources.get(source)
    if (existing) {
      if (existing.owner !== owner) {
        throw new Error(`Source "${source}" already registered for operation "${operation}"`)
      }
      return existing
    }

    const runtime = {
      active: false,
      activeOperations: 0,
      contributors: operationRuntime.contributors,
      consumers: new Set(),
      create,
      instance: undefined,
      operation,
      owner,
      primaryConsumer: undefined,
      source,
    }
    operationRuntime.sources.set(source, runtime)
    this.#updateSource(operationRuntime, runtime)

    return runtime
  }

  /**
   * Enable a package bridge for one source consumer.
   *
   * Repeated acquisition by the same consumer is idempotent.
   *
   * @param {string} operation Stable semantic operation identifier.
   * @param {string} source Stable package or platform source identifier.
   * @param {object} consumer Stable consumer identity.
   * @returns {void}
   */
  acquireSource (operation, source, consumer) {
    const operationRuntime = this.#getOperation(operation)
    const runtime = this.#getSource(operationRuntime, operation, source)

    runtime.consumers.add(consumer)
    if (runtime.consumers.size === 1) runtime.primaryConsumer = consumer
    this.#updateSource(operationRuntime, runtime)
  }

  /**
   * Release a package bridge without affecting its remaining consumers.
   *
   * @param {string} operation Stable semantic operation identifier.
   * @param {string} source Stable package or platform source identifier.
   * @param {object} consumer Stable consumer identity.
   * @returns {void}
   */
  releaseSource (operation, source, consumer) {
    const operationRuntime = this.#getOperation(operation)
    const runtime = this.#getSource(operationRuntime, operation, source)

    if (runtime.consumers.delete(consumer) && runtime.primaryConsumer === consumer) {
      runtime.primaryConsumer = runtime.consumers.values().next().value
    }
    this.#updateSource(operationRuntime, runtime)
  }

  /**
   * Keep a physical source bridge active until an observed operation reaches its terminal phase.
   *
   * @param {object} runtime Registered source runtime.
   * @returns {void}
   */
  holdOperation (runtime) {
    runtime.activeOperations++
  }

  /**
   * Release an in-flight operation and disable its bridge when no consumer remains.
   *
   * @param {object} runtime Registered source runtime.
   * @returns {void}
   */
  releaseOperation (runtime) {
    if (runtime.activeOperations === 0) return

    runtime.activeOperations--
    if (runtime.activeOperations > 0 || runtime.consumers.size > 0) return

    const operationRuntime = this.#operations.get(runtime.operation)
    if (operationRuntime) this.#updateSource(operationRuntime, runtime)
  }

  /**
   * Register a product contributor and activate every source for its operation.
   *
   * @param {string} operation Stable semantic operation identifier.
   * @param {string} id Stable contributor identifier.
   * @param {object & {sources?: Set<string>}} contributor Product lifecycle contributor.
   * @returns {void}
   */
  registerContributor (operation, id, contributor) {
    const operationRuntime = this.#getOperation(operation, true)
    const existing = operationRuntime.contributors.get(id)
    if (existing) {
      if (existing !== contributor) {
        throw new Error(`Contributor "${id}" already registered for operation "${operation}"`)
      }
      return
    }

    operationRuntime.contributors.set(id, contributor)
    for (const runtime of operationRuntime.sources.values()) {
      this.#updateSource(operationRuntime, runtime)
    }
  }

  /**
   * Remove a product contributor and release sources with no other consumers.
   *
   * @param {string} operation Stable semantic operation identifier.
   * @param {string} id Stable contributor identifier.
   * @returns {void}
   */
  unregisterContributor (operation, id) {
    const operationRuntime = this.#operations.get(operation)
    if (!operationRuntime?.contributors.delete(id)) return

    for (const runtime of operationRuntime.sources.values()) {
      this.#updateSource(operationRuntime, runtime)
    }
  }

  /**
   * Snapshot eligible product contributors and run their start phase.
   *
   * The snapshot preserves lifecycle ownership when contributors register or unregister during an async operation.
   *
   * @param {string} operation Stable semantic operation identifier.
   * @param {object & {source?: {integration?: string}}} event Normalized product event.
   * @param {object | undefined} store Parent operation store.
   * @returns {object | undefined} Opaque contributor lifecycle, when at least one contributor is eligible.
   */
  startContributors (operation, event, store) {
    const contributors = this.#operations.get(operation)?.contributors
    if (!contributors || contributors.size === 0) return

    const registrations = []
    for (const [id, contributor] of contributors) {
      if (contributor.sources && !contributor.sources.has(event.source?.integration)) continue
      registrations.push({ contributor, id })
    }
    if (registrations.length === 0) return

    const lifecycle = { event, registrations, store }
    this.#runContributors(lifecycle, 'start')

    return lifecycle
  }

  /**
   * Run a terminal product phase over the contributors captured at start.
   *
   * @param {object | undefined} lifecycle Opaque contributor lifecycle returned by `startContributors`.
   * @param {string} phase Product lifecycle phase.
   * @returns {object | undefined} Store returned by the contributor pipeline.
   */
  runContributorPhase (lifecycle, phase) {
    if (!lifecycle) return

    this.#runContributors(lifecycle, phase)
    return lifecycle.store
  }

  /**
   * Compose one phase without exposing registry lifecycle state to product contributors.
   *
   * @param {object} lifecycle Internal contributor lifecycle.
   * @param {string} phase Product lifecycle phase.
   * @returns {void}
   */
  #runContributors (lifecycle, phase) {
    const { event, registrations } = lifecycle
    let { store } = lifecycle

    for (const { contributor, id } of registrations) {
      const handler = contributor[phase]
      if (!handler) continue

      try {
        const nextStore = handler(event, store)
        if (nextStore !== undefined) store = nextStore
      } catch (error) {
        log.error('Event contributor "%s" failed during %s: %s', id, phase, error?.message || error)
      }
    }

    lifecycle.store = store
  }

  /**
   * Resolve a registered source runtime.
   *
   * @param {string} operation Stable semantic operation identifier.
   * @param {string} source Stable package or platform source identifier.
   * @returns {object | undefined} Source bridge runtime.
   */
  getSource (operation, source) {
    return this.#operations.get(operation)?.sources.get(source)
  }

  /**
   * Resolve or create the runtime for one semantic operation.
   *
   * @param {string} operation Stable semantic operation identifier.
   * @param {boolean} [create] Whether to create a missing operation.
   * @returns {object} Semantic operation runtime.
   */
  #getOperation (operation, create = false) {
    let operationRuntime = this.#operations.get(operation)
    if (!operationRuntime && create) {
      operationRuntime = {
        contributors: new Map(),
        sources: new Map(),
      }
      this.#operations.set(operation, operationRuntime)
    }
    if (!operationRuntime) {
      throw new Error(`No event sources registered for operation "${operation}"`)
    }

    return operationRuntime
  }

  /**
   * Resolve a source runtime owned by an operation.
   *
   * @param {object} operationRuntime Semantic operation runtime.
   * @param {string} operation Stable semantic operation identifier.
   * @param {string} source Stable package or platform source identifier.
   * @returns {object} Registered source runtime.
   */
  #getSource (operationRuntime, operation, source) {
    const runtime = operationRuntime.sources.get(source)
    if (!runtime) {
      throw new Error(`No event source "${source}" registered for operation "${operation}"`)
    }

    return runtime
  }

  /**
   * Synchronize a source bridge with its current consumer set.
   *
   * @param {object} operationRuntime Semantic operation runtime.
   * @param {object} runtime Registered source runtime.
   * @returns {void}
   */
  #updateSource (operationRuntime, runtime) {
    const active = runtime.activeOperations > 0 || runtime.consumers.size > 0 ||
      this.#hasContributor(operationRuntime, runtime.source)
    if (runtime.active === active) return

    runtime.instance ||= runtime.create(runtime)
    runtime.instance.configure({ enabled: active })
    runtime.active = active
  }

  /**
   * Check whether any product contributor consumes a package source.
   *
   * @param {object} operationRuntime Semantic operation runtime.
   * @param {string} source Stable package or platform source identifier.
   * @returns {boolean} Whether a contributor consumes the source.
   */
  #hasContributor (operationRuntime, source) {
    for (const contributor of operationRuntime.contributors.values()) {
      if (!contributor.sources || contributor.sources.has(source)) return true
    }

    return false
  }
}

const sourceRegistry = new EventSourceRegistry()

/**
 * Resolve the process-wide event source registry.
 *
 * @returns {EventSourceRegistry} Shared event source registry.
 */
function getEventSourceRegistry () {
  return sourceRegistry
}

module.exports = {
  EventSourceRegistry,
  getEventSourceRegistry,
}
