'use strict'

const { performance } = require('node:perf_hooks')
const { Readable, Writable } = require('node:stream')

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const Plugin = require('../../dd-trace/src/plugins/plugin')

const ACQUIRE_START_CHANNEL = 'tracing:orchestrion:postgres:query:acquire:start'
const PREPARE_START_CHANNEL = 'tracing:orchestrion:postgres:query:prepare:start'
const COPY_START_CHANNEL = 'tracing:orchestrion:postgres:query:copy:start'

/**
 * @typedef {object} PostgresContext
 * @property {PostgresStore} currentStore
 * @property {string} database
 * @property {unknown} [error]
 * @property {string} [host]
 * @property {number} [pid]
 * @property {number} [port]
 * @property {boolean} [poolWaitFinished]
 * @property {number} [poolWaitStartMs]
 * @property {PostgresQuery} query
 * @property {string} [statement]
 * @property {string} user
 *
 * @typedef {object} PostgresStore
 * @property {import('../../..').Span} span
 * @property {string} [dbmService]
 * @property {string} [statement]
 *
 * @typedef {object} PostgresPreparationContext
 * @property {string} [host]
 * @property {number} [port]
 * @property {boolean} prepared
 * @property {PostgresQuery | NativePostgresContext} query
 * @property {string} [resource]
 * @property {string} statement
 *
 * @typedef {object} PostgresCopyContext
 * @property {Error | null} error
 * @property {NativePostgresContext} query
 *
 * @typedef {object} PostgresQuery
 *
 * @typedef {object} NativePostgresContext
 * @property {PostgresStore} [currentStore]
 * @property {string} database
 * @property {Error} [error]
 * @property {string | null} host
 * @property {number | null} port
 * @property {string | null} query
 * @property {number} queued
 * @property {unknown} [result]
 * @property {number | null} sent
 * @property {string} user
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

class PostgresCopyPlugin extends Plugin {
  static id = 'postgres'

  /**
   * @param {(ctx: PostgresCopyContext) => void} finish
   * @param {object} tracer
   * @param {import('../../dd-trace/src/config/config-base')} tracerConfig
   */
  constructor (finish, tracer, tracerConfig) {
    super(tracer, tracerConfig)
    this.addSub(COPY_START_CHANNEL, finish)
  }
}

class PostgresPlugin extends DatabasePlugin {
  static id = 'postgres'
  static prefix = 'tracing:orchestrion:postgres:query'

  /** @type {boolean} */
  #dbmEnabled = false

  /** @type {WeakMap<PostgresQuery, PostgresContext>} */
  #contexts = new WeakMap()

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
    this.addSub(ACQUIRE_START_CHANNEL, ctx => this.#finishPoolWait(ctx.query))
    this.addBind('tracing:postgres:query:start', ctx => this.#nativeStart(ctx))
    this.addSub('tracing:postgres:query:error', ctx => {
      if (ctx.currentStore) this.addError(ctx.error, ctx.currentStore.span)
    })
    this.addSub('tracing:postgres:query:asyncEnd', ctx => {
      if (!(ctx.result instanceof Readable || ctx.result instanceof Writable)) this.#finishNative(ctx)
    })
    this.#preparation = new PostgresPreparationPlugin(this.#prepare.bind(this), tracer, tracerConfig)
    const copy = new PostgresCopyPlugin(ctx => {
      const store = ctx.query.currentStore
      if (store === undefined) return
      if (ctx.error) this.addError(ctx.error, store.span)
      this.#finishNative(ctx.query)
    }, tracer, tracerConfig)
    // Complete in-flight COPY spans even after this plugin is disabled.
    copy.configure(true)
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
   * @returns {object}
   */
  bindStart (ctx) {
    this.#contexts.set(ctx.query, ctx)
    return this.#start(ctx)
  }

  /**
   * @param {PostgresContext | NativePostgresContext} ctx
   */
  #start (ctx) {
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

    if (this.#dbmEnabled) ctx.currentStore.dbmService = service.name
    return ctx.currentStore
  }

  /**
   * @param {NativePostgresContext} ctx
   */
  #nativeStart (ctx) {
    const store = this.#start(ctx)
    if (typeof ctx.query === 'string') {
      store.span.setTag('resource.name', this.maybeTruncate(ctx.query))
    }
    return store
  }

  /**
   * @param {NativePostgresContext} ctx
   */
  #finishNative (ctx) {
    const store = ctx.currentStore
    if (store === undefined) return
    const { span } = store

    if (ctx.host !== null) {
      span.addTags({ 'out.host': ctx.host, [CLIENT_PORT_KEY]: ctx.port })
    }
    span.setTag('db.pool.wait_time_ms', ctx.sent === null ? 0 : ctx.sent - ctx.queued)
    if (store.statement === undefined && typeof ctx.query === 'string') {
      span.setTag('resource.name', this.maybeTruncate(ctx.query))
    }
    this.finish(ctx)
  }

  /**
   * @param {PostgresQuery} query
   */
  #finishPoolWait (query) {
    const ctx = this.#contexts.get(query)
    if (ctx === undefined || ctx.poolWaitFinished) return

    ctx.poolWaitFinished = true
    const waitTime = ctx.poolWaitStartMs === undefined ? 0 : performance.now() - ctx.poolWaitStartMs
    ctx.currentStore.span.setTag('db.pool.wait_time_ms', waitTime)
  }

  /**
   * @param {PostgresPreparationContext} ctx
   */
  #prepare (ctx) {
    const store = ctx.query.currentStore ?? this.#contexts.get(ctx.query)?.currentStore
    if (store?.dbmService === undefined) return
    const { span } = store

    store.statement = ctx.resource ?? ctx.statement
    span.setTag('resource.name', this.maybeTruncate(store.statement))
    if (ctx.host !== undefined) {
      span.addTags({ 'out.host': ctx.host, [CLIENT_PORT_KEY]: ctx.port })
    }
    ctx.statement = this.injectDbmQuery(span, ctx.statement, store.dbmService, ctx.prepared)
  }

  /**
   * @param {Pick<PostgresContext, 'query' | 'error'>} ctx
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
    const { query, statement, pid } = result
    const ctx = this.#contexts.get(query)
    if (ctx === undefined) return
    const { currentStore: { span, statement: originalStatement } } = ctx

    this.#finishPoolWait(query)
    this.#contexts.delete(query)

    if (originalStatement === undefined && typeof statement === 'string') {
      span.setTag('resource.name', this.maybeTruncate(statement))
    }

    span.setTag('db.pid', pid)
    this.finish(ctx)
  }
}

module.exports = PostgresPlugin
