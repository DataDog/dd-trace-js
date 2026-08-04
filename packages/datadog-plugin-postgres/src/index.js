'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

/**
 * @typedef {object} PostgresOptions
 * @property {string} database
 * @property {string[]} host
 * @property {number[]} port
 * @property {string} user
 *
 * @typedef {object} PostgresQuery
 * @property {boolean} prepare
 * @property {{ simple?: boolean }} options
 * @property {string} string
 * @property {string[]} strings
 * @property {boolean} tagged
 * @property {{ pid?: number } | null} state
 *
 * @typedef {object} PostgresContext
 * @property {{ span: import('../../dd-trace').Span }} currentStore
 * @property {unknown} [error]
 * @property {PostgresOptions} options
 * @property {PostgresQuery} query
 * @property {{ name: string, source?: string }} service
 * @property {string} [statement]
 */

class PostgresPlugin extends DatabasePlugin {
  static id = 'postgres'
  static operation = 'query'
  static prefix = 'tracing:orchestrion:postgres:query'
  static system = 'postgres'

  /** @type {WeakMap<PostgresQuery, PostgresContext>} */
  #contexts = new WeakMap()

  /**
   * @param {PostgresContext} ctx
   */
  bindStart (ctx) {
    const { options, query } = ctx
    const service = this.serviceName({ pluginConfig: this.config, params: options })

    this.startSpan(this.operationName(), {
      service,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': this.system,
        'db.name': options.database,
        'db.user': options.user,
        'out.host': options.host[0],
        [CLIENT_PORT_KEY]: options.port[0],
      },
    }, ctx)

    ctx.service = service
    this.#contexts.set(query, ctx)

    return ctx.currentStore
  }

  /**
   * @param {PostgresQuery} query
   */
  asyncStart (query) {
    if (this.config.dbmPropagationMode === undefined || this.config.dbmPropagationMode === 'disabled') return

    const ctx = this.#contexts.get(query)
    const span = ctx?.currentStore?.span
    if (span === undefined) return

    ctx.statement = query.string
    query.string = this.injectDbmQuery(span, query.string, ctx.service.name, query.prepare)

    if (query.options.simple) {
      // Postgres.js 3.0 sends simple queries from strings[0], which can be a frozen template array.
      query.strings = [query.string]
    }
  }

  /**
   * @param {{ query: PostgresQuery, error: unknown }} ctx
   */
  error (ctx) {
    const span = this.#contexts.get(ctx.query)?.currentStore?.span
    if (span !== undefined) {
      this.addError(ctx.error, span)
    }
  }

  /**
   * @param {PostgresQuery} query
   */
  asyncEnd (query) {
    const ctx = this.#contexts.get(query)
    if (ctx === undefined) return

    this.#contexts.delete(query)

    const span = ctx.currentStore.span

    const statement = ctx.statement ?? query.string ?? (query.tagged ? undefined : query.strings?.[0])
    if (typeof statement === 'string') {
      span.setTag('resource.name', this.maybeTruncate(statement))
    }
    span.setTag('db.pid', query.state?.pid)
    this.finish(ctx)
  }
}

module.exports = PostgresPlugin
