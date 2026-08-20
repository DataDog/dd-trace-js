'use strict'

class QueryLifecycleAdapter {
  /**
   * Start one database query through the generic trace manager.
   *
   * @param {object} input Query start input.
   * @param {import('../trace-manager')} input.traceManager Generic trace manager.
   * @param {{name: string, options: object}} input.plan Resolved database query plan.
   * @param {object} input.context Source lifecycle context.
   * @param {object} input.facts Normalized source facts.
   * @returns {object} Query lifecycle token.
   */
  start ({ traceManager, plan, context, facts }) {
    return {
      facts,
      operation: traceManager.start(plan, context),
      traceManager,
    }
  }

  /**
   * Apply completion metadata and finish a database query.
   *
   * @param {object} token Query lifecycle token.
   * @param {Record<string, unknown> | undefined} metadata Completion tags and metrics.
   * @returns {void}
   */
  complete (token, metadata) {
    try {
      token.traceManager.update(token.operation, metadata)
    } finally {
      token.traceManager.finish(token.operation)
    }
  }

  /**
   * Apply error metadata, record the application error, and finish a database query.
   *
   * @param {object} token Query lifecycle token.
   * @param {unknown} error Application error.
   * @param {Record<string, unknown> | undefined} metadata Error response tags and metrics.
   * @returns {void}
   */
  error (token, error, metadata) {
    try {
      token.traceManager.update(token.operation, metadata)
      token.traceManager.error(token.operation, error)
    } finally {
      token.traceManager.finish(token.operation)
    }
  }
}

module.exports = QueryLifecycleAdapter
