'use strict'

/**
 * @typedef {object} TracePlugin
 * @property {(name: string, options: object, context: object) => import('../../../../index').Span} startSpan
 * @property {(error: unknown, span: import('../../../../index').Span) => void} addError
 * @property {(span: import('../../../../index').Span) => void} finishSpan
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
   * @param {string} name Resolved trace operation name.
   * @param {object} options Resolved trace operation options.
   * @param {object} context Lifecycle context used for store binding and finalization.
   * @param {object} [operation] Existing lifecycle identity, when the source provides one.
   * @returns {object} Trace operation token or supplied lifecycle identity.
   */
  start (name, options, context, operation = Object.freeze({})) {
    const span = this.#plugin.startSpan(name, options, context)
    this.#operations.set(operation, span)

    return operation
  }

  /**
   * Complete an active trace operation exactly once and release its state.
   *
   * @param {object} operation Opaque trace operation token.
   * @param {Record<string, unknown> | undefined} metadata Span tags or metrics resolved at completion.
   * @returns {void}
   */
  complete (operation, metadata) {
    const span = this.#operations.get(operation)
    if (!span) return

    try {
      if (metadata) span.addTags(metadata)
    } finally {
      this.#operations.delete(operation)
      this.#plugin.finishSpan(span)
    }
  }

  /**
   * Fail an active trace operation exactly once and release its state.
   *
   * @param {object} operation Opaque trace operation token.
   * @param {unknown} error Application error or error sentinel.
   * @param {Record<string, unknown> | undefined} metadata Error response tags and metrics.
   * @returns {void}
   */
  fail (operation, error, metadata) {
    const span = this.#operations.get(operation)
    if (!span) return

    try {
      if (metadata) span.addTags(metadata)
      this.#plugin.addError(error, span)
    } finally {
      this.#operations.delete(operation)
      this.#plugin.finishSpan(span)
    }
  }
}

module.exports = TraceManager
