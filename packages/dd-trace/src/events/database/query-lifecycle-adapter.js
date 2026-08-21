'use strict'

class QueryLifecycleAdapter {
  #traceManager

  /**
   * Create the fixed query lifecycle over one processor's trace manager.
   *
   * @param {import('../trace-manager')} traceManager Generic trace manager.
   */
  constructor (traceManager) {
    this.#traceManager = traceManager
  }

  /**
   * Start one database query through the generic trace manager.
   *
   * @param {string} name Resolved database span operation name.
   * @param {object} options Resolved database span options.
   * @param {object} context Source lifecycle context.
   * @returns {object} Query lifecycle identity.
   */
  start (name, options, context) {
    return this.#traceManager.start(name, options, context, context)
  }

  /**
   * Apply completion metadata and finish a database query.
   *
   * @param {object} operation Query lifecycle identity.
   * @param {Record<string, unknown> | undefined} metadata Completion tags and metrics.
   * @returns {void}
   */
  complete (operation, metadata) {
    this.#traceManager.complete(operation, metadata)
  }

  /**
   * Apply error metadata, record the application error, and finish a database query.
   *
   * @param {object} operation Query lifecycle identity.
   * @param {unknown} error Application error.
   * @param {Record<string, unknown> | undefined} metadata Error response tags and metrics.
   * @returns {void}
   */
  error (operation, error, metadata) {
    this.#traceManager.fail(operation, error, metadata)
  }
}

module.exports = QueryLifecycleAdapter
