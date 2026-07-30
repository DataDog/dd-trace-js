'use strict'

class EventSourceRegistry {
  /**
   * Create a process-wide source and product contributor registry.
   */
  constructor () {
    this._operations = new Map()
  }

  /**
   * Register a lazily-created package bridge for one semantic operation.
   *
   * @param {object} definition Source bridge definition.
   * @param {string} definition.operation Stable semantic operation identifier.
   * @param {string} definition.source Stable package or platform source identifier.
   * @param {string} definition.owner Stable module owning the source key.
   * @param {Function} definition.create Factory returning a configurable source bridge.
   * @returns {object} Stable source bridge runtime.
   */
  registerSource ({ operation, source, owner, create }) {
    if (!owner) {
      throw new Error(`Source "${source}" requires an owner for operation "${operation}"`)
    }

    const operationRuntime = this._getOperation(operation, true)
    const existing = operationRuntime.sources.get(source)
    if (existing) {
      if (existing.owner !== owner) {
        throw new Error(`Source "${source}" already registered for operation "${operation}"`)
      }
      return existing
    }

    const runtime = {
      active: false,
      consumers: new Set(),
      create,
      instance: undefined,
      operation,
      owner,
      source,
    }
    operationRuntime.sources.set(source, runtime)
    this._updateSource(operationRuntime, runtime)

    return runtime
  }

  /**
   * Enable a package bridge for one source consumer.
   *
   * @param {string} operation Stable semantic operation identifier.
   * @param {string} source Stable package or platform source identifier.
   * @param {object} consumer Stable consumer identity.
   * @returns {void}
   */
  acquireSource (operation, source, consumer) {
    const operationRuntime = this._getOperation(operation)
    const runtime = this._getSource(operationRuntime, operation, source)

    runtime.consumers.add(consumer)
    this._updateSource(operationRuntime, runtime)
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
    const operationRuntime = this._getOperation(operation)
    const runtime = this._getSource(operationRuntime, operation, source)

    runtime.consumers.delete(consumer)
    this._updateSource(operationRuntime, runtime)
  }

  /**
   * Register a product contributor and activate every source for its operation.
   *
   * @param {string} operation Stable semantic operation identifier.
   * @param {string} id Stable contributor identifier.
   * @param {object} contributor Product lifecycle contributor. An optional
   * `sources` Set limits bridge activation and event handling to those sources.
   * @returns {void}
   */
  registerContributor (operation, id, contributor) {
    const operationRuntime = this._getOperation(operation, true)
    const existing = operationRuntime.contributors.get(id)
    if (existing) {
      if (existing !== contributor) {
        throw new Error(`Contributor "${id}" already registered for operation "${operation}"`)
      }
      return
    }

    operationRuntime.contributors.set(id, contributor)
    for (const runtime of operationRuntime.sources.values()) {
      this._updateSource(operationRuntime, runtime)
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
    const operationRuntime = this._operations.get(operation)
    if (!operationRuntime?.contributors.delete(id)) return

    for (const runtime of operationRuntime.sources.values()) {
      this._updateSource(operationRuntime, runtime)
    }
  }

  /**
   * Run one product lifecycle phase and compose returned context stores.
   *
   * @param {string} operation Stable semantic operation identifier.
   * @param {string} phase Product lifecycle phase.
   * @param {object} event Normalized source event.
   * @param {object|undefined} store Current operation store.
   * @returns {object|undefined} Store returned by the contributor pipeline.
   */
  runContributors (operation, phase, event, store) {
    const contributors = this._operations.get(operation)?.contributors
    if (!contributors) return store

    for (const contributor of contributors.values()) {
      if (contributor.sources && !contributor.sources.has(event.source?.integration)) continue

      const handler = contributor[phase]
      if (!handler) continue

      const nextStore = handler(event, store)
      if (nextStore !== undefined) store = nextStore
    }

    return store
  }

  /**
   * Resolve a registered source runtime.
   *
   * @param {string} operation Stable semantic operation identifier.
   * @param {string} source Stable package or platform source identifier.
   * @returns {object|undefined} Source bridge runtime.
   */
  getSource (operation, source) {
    return this._operations.get(operation)?.sources.get(source)
  }

  /**
   * Resolve or create the runtime for one semantic operation.
   *
   * @param {string} operation Stable semantic operation identifier.
   * @param {boolean} [create] Whether to create a missing operation.
   * @returns {object} Semantic operation runtime.
   */
  _getOperation (operation, create = false) {
    let operationRuntime = this._operations.get(operation)
    if (!operationRuntime && create) {
      operationRuntime = {
        contributors: new Map(),
        sources: new Map(),
      }
      this._operations.set(operation, operationRuntime)
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
  _getSource (operationRuntime, operation, source) {
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
  _updateSource (operationRuntime, runtime) {
    const active = runtime.consumers.size > 0 || this._hasContributor(operationRuntime, runtime.source)
    if (runtime.active === active) return

    runtime.instance ||= runtime.create()
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
  _hasContributor (operationRuntime, source) {
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
