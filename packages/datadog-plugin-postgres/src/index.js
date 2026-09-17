'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const Plugin = require('../../dd-trace/src/plugins/plugin')

const PREPARE_START_CHANNEL = 'tracing:orchestrion:postgres:query:prepare:start'

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
 * @typedef {object} PostgresDbmState
 * @property {string} service
 * @property {string} [statement]
 *
 * @typedef {object} PostgresPreparationContext
 * @property {boolean} prepared
 * @property {PostgresQuery} query
 * @property {string} statement
 *
 * @typedef {object} PostgresQuery
 */

class PostgresPreparationPlugin extends Plugin {
  static id = 'postgres'

  /**
   * @param {(ctx: PostgresPreparationContext) => void} prepare
   * @param {object} tracer
   * @param {import('../../dd-trace/src/config/config-base')} tracerConfig
   */
  constructor (prepare, tracer, tracerConfig) {
    super(tracer, tracerConfig)
    this.addSub(PREPARE_START_CHANNEL, prepare)
  }
}

class PostgresPlugin extends DatabasePlugin {
  static id = 'postgres'
  static prefix = 'tracing:orchestrion:postgres:query'

  /** @type {boolean} */
  #dbmEnabled = false

  /** @type {WeakMap<PostgresQuery, PostgresDbmState>} */
  #dbmQueries = new WeakMap()

  /** @type {PostgresPreparationPlugin} */
  #preparation

  /** @type {WeakMap<PostgresQuery, import('../../..').Span>} */
  #spans = new WeakMap()

  /**
   * @param {object} tracer
   * @param {import('../../dd-trace/src/config/config-base')} tracerConfig
   */
  constructor (tracer, tracerConfig) {
    super(tracer, tracerConfig)
    this.#preparation = new PostgresPreparationPlugin(this.#prepare.bind(this), tracer, tracerConfig)
  }

  /**
   * @override
   * @param {boolean | import('../../dd-trace/src/config/config-base') & {enabled: boolean}} config
   */
  configure (config) {
    super.configure(config)

    const mode = this.config.dbmPropagationMode
    this.#dbmEnabled = mode === 'service' || mode === 'full' || mode === 'dynamic_service'
    this.#preparation.configure(this.config.enabled === true && this.#dbmEnabled)
  }

  /**
   * @param {PostgresContext} ctx
   * @returns {object}
   */
  bindStart (ctx) {
    const { database, host, port, query, user } = ctx
    const service = this.serviceName({ pluginConfig: this.config })

    const span = this.startSpan(this.operationName(), {
      service,
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

    this.#spans.set(query, span)
    if (this.#dbmEnabled) {
      this.#dbmQueries.set(query, { service: service.name })
    }
    return ctx.currentStore
  }

  /**
   * @param {PostgresPreparationContext} ctx
   */
  #prepare (ctx) {
    const state = this.#dbmQueries.get(ctx.query)
    const span = this.#spans.get(ctx.query)
    if (state === undefined || span === undefined) return

    state.statement = ctx.statement
    span.setTag('resource.name', this.maybeTruncate(ctx.statement))
    ctx.statement = this.injectDbmQuery(span, ctx.statement, state.service, ctx.prepared)
  }

  /**
   * @param {PostgresContext} ctx
   */
  error (ctx) {
    const span = this.#spans.get(ctx.query)
    if (span !== undefined) {
      this.addError(ctx.error, span)
    }
  }

  /**
   * @param {PostgresContext} result
   */
  asyncEnd (result) {
    const { query } = result
    const dbmState = this.#dbmQueries.get(query)
    const span = this.#spans.get(query)

    this.#dbmQueries.delete(query)
    if (span === undefined) return

    this.#spans.delete(query)

    const statement = dbmState?.statement ?? result.statement
    if (dbmState?.statement === undefined && typeof statement === 'string') {
      span.setTag('resource.name', this.maybeTruncate(statement))
    }

    span.setTag('db.pid', result.pid)
    this.finish({ currentStore: { span } })
  }
}

module.exports = PostgresPlugin
