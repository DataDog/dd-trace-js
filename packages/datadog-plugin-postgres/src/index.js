'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

/**
 * @typedef {object} PostgresContext
 * @property {{ span: import('../../..').Span }} currentStore
 * @property {string} database
 * @property {unknown} [error]
 * @property {string} [host]
 * @property {number} [pid]
 * @property {number} [port]
 * @property {PostgresQuery} query
 * @property {string} [statement]
 * @property {string} user
 *
 * @typedef {object} PostgresQuery
 */

class PostgresPlugin extends DatabasePlugin {
  static id = 'postgres'
  static prefix = 'tracing:orchestrion:postgres:query'

  /** @type {WeakMap<PostgresQuery, PostgresContext>} */
  #contexts = new WeakMap()

  /**
   * @param {PostgresContext} ctx
   * @returns {object}
   */
  bindStart (ctx) {
    const { database, host, port, query, user } = ctx

    const span = this.startSpan(this.operationName(), {
      service: this.serviceName({ pluginConfig: this.config }),
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': this.system,
        'db.name': database,
        'db.user': user,
      },
    }, ctx)

    if (host !== undefined) {
      span.addTags({
        'out.host': host,
        [CLIENT_PORT_KEY]: port,
      })
    }

    this.#contexts.set(query, ctx)
    return ctx.currentStore
  }

  /**
   * @param {PostgresContext} ctx
   */
  error (ctx) {
    const span = this.#contexts.get(ctx.query)?.currentStore.span
    if (span !== undefined) {
      this.addError(ctx.error, span)
    }
  }

  /**
   * @param {PostgresContext} result
   */
  asyncEnd (result) {
    const ctx = this.#contexts.get(result.query)
    if (ctx === undefined) return

    this.#contexts.delete(result.query)

    const span = ctx.currentStore.span

    if (typeof result.statement === 'string') {
      span.setTag('resource.name', this.maybeTruncate(result.statement))
    }

    span.setTag('db.pid', result.pid)
    this.finish(ctx)
  }
}

module.exports = PostgresPlugin
