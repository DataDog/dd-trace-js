'use strict'

/**
 * @typedef {object} TracePlan
 * @property {string} name
 * @property {object} options
 */

/**
 * @typedef {object} TracePlugin
 * @property {(name: string, options: object, context: object) => import('../../../../index').Span} startSpan
 * @property {(error: unknown, span: import('../../../../index').Span) => void} addError
 * @property {(context: object) => void} finish
 */

class TraceManager {
  #operations = new WeakMap()
  #plugin

  /**
   * Create a domain-neutral tracing boundary backed by an existing plugin compatibility layer.
   *
   * @param {TracePlugin} plugin Plugin responsible for span creation and integration-specific finalization.
   */
  constructor (plugin) {
    this.#plugin = plugin
  }

  /**
   * Start one trace operation and return an opaque lifecycle token.
   *
   * @param {TracePlan} plan Resolved trace operation plan.
   * @param {object} context Lifecycle context used for store binding and finalization.
   * @returns {object} Opaque trace operation token.
   */
  start (plan, context) {
    const span = this.#plugin.startSpan(plan.name, plan.options, context)
    const operation = Object.freeze({})
    this.#operations.set(operation, { context, span })

    return operation
  }

  /**
   * Add completion metadata to an active trace operation.
   *
   * @param {object} operation Opaque trace operation token.
   * @param {Record<string, unknown> | undefined} metadata Span tags or metrics resolved at completion.
   * @returns {void}
   */
  update (operation, metadata) {
    if (!metadata) return
    this.#operations.get(operation)?.span.addTags(metadata)
  }

  /**
   * Record an application error on an active trace operation.
   *
   * @param {object} operation Opaque trace operation token.
   * @param {unknown} error Application error or error sentinel.
   * @returns {void}
   */
  error (operation, error) {
    const state = this.#operations.get(operation)
    if (state) this.#plugin.addError(error, state.span)
  }

  /**
   * Finish an active trace operation exactly once and release its state.
   *
   * @param {object} operation Opaque trace operation token.
   * @returns {void}
   */
  finish (operation) {
    const state = this.#operations.get(operation)
    if (!state) return

    this.#operations.delete(operation)
    this.#plugin.finish(state.context)
  }
}

module.exports = TraceManager
