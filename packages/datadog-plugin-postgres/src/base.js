'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const Plugin = require('../../dd-trace/src/plugins/plugin')

/**
 * @typedef {object} PostgresStore
 * @property {import('../../..').Span} span
 * @property {string} [dbmService]
 * @property {string} [statement]
 *
 * @typedef {object} PostgresContext
 * @property {PostgresStore} [currentStore]
 * @property {string} database
 * @property {string | null} [host]
 * @property {number | null} [port]
 * @property {object | string | null} query
 * @property {string} user
 *
 * @typedef {object} PostgresQuery
 * @property {PostgresStore} [currentStore]
 *
 * @typedef {object} PostgresPreparationContext
 * @property {string} [host]
 * @property {number} [port]
 * @property {boolean} prepared
 * @property {PostgresQuery} query
 * @property {string} [resource]
 * @property {string} statement
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
    this.addSub('tracing:orchestrion:postgres:query:prepare:start', prepare)
  }
}

class PostgresBasePlugin extends DatabasePlugin {
  static id = 'postgres'

  /** @type {boolean} */
  #dbmEnabled = false

  /** @type {PostgresPreparationPlugin} */
  #preparation

  /** @type {{ name: string, source: string | undefined }} */
  #service

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

    this.#service = this.serviceName({ pluginConfig: this.config })
    const mode = this.config.dbmPropagationMode
    this.#dbmEnabled = mode === 'service' || mode === 'full' || mode === 'dynamic_service'
    this.#preparation.configure(this.config.enabled === true && this.#dbmEnabled)
  }

  /**
   * @param {PostgresContext} ctx
   */
  bindStart (ctx) {
    const { database, host, port, user } = ctx
    const service = this.#service

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

    if (host != null) {
      span.addTags({
        'out.host': host,
        [CLIENT_PORT_KEY]: port,
      })
    }

    if (this.#dbmEnabled) {
      ctx.currentStore.dbmService = service.name
    }
    return ctx.currentStore
  }

  /**
   * @param {PostgresQuery} query
   */
  getStore (query) {
    return query.currentStore
  }

  /**
   * @param {PostgresPreparationContext} ctx
   */
  #prepare (ctx) {
    const store = this.getStore(ctx.query)
    if (store?.dbmService === undefined) {
      return
    }
    const { span } = store

    store.statement = ctx.resource ?? ctx.statement
    span.setTag('resource.name', this.maybeTruncate(store.statement))
    if (ctx.host !== undefined) {
      span.addTags({ 'out.host': ctx.host, [CLIENT_PORT_KEY]: ctx.port })
    }
    ctx.statement = this.injectDbmQuery(span, ctx.statement, store.dbmService, ctx.prepared)
  }
}

module.exports = PostgresBasePlugin
