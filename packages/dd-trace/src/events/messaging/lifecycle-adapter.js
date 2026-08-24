'use strict'

class MessagingLifecycleAdapter {
  #traceManager

  /**
   * Create one fixed messaging lifecycle over a processor's trace manager.
   *
   * @param {import('../trace-manager')} traceManager Generic trace manager.
   */
  constructor (traceManager) {
    this.#traceManager = traceManager
  }

  /**
   * Start one message operation through the generic trace manager.
   *
   * @param {string} name Resolved messaging span operation name.
   * @param {object} options Resolved messaging span options.
   * @param {object} context Source lifecycle context.
   * @returns {object} Messaging lifecycle identity.
   */
  start (name, options, context) {
    return this.#traceManager.start(name, options, context, context)
  }

  /**
   * Apply completion metadata and finish a message operation.
   *
   * @param {object} operation Messaging lifecycle identity.
   * @param {Record<string, unknown> | undefined} metadata Completion tags and metrics.
   * @returns {void}
   */
  complete (operation, metadata) {
    this.#traceManager.complete(operation, metadata)
  }

  /**
   * Apply error metadata, record the application error, and finish a message operation.
   *
   * @param {object} operation Messaging lifecycle identity.
   * @param {unknown} error Application error.
   * @param {Record<string, unknown> | undefined} metadata Error tags and metrics.
   * @returns {void}
   */
  error (operation, error, metadata) {
    this.#traceManager.fail(operation, error, metadata)
  }
}

module.exports = MessagingLifecycleAdapter
