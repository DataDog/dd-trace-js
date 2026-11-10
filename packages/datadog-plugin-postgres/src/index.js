'use strict'

const { errorMonitor } = require('node:events')
const { performance } = require('node:perf_hooks')
const { Readable, Writable } = require('node:stream')

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const Plugin = require('../../dd-trace/src/plugins/plugin')

const ACQUIRE_START_CHANNEL = 'tracing:orchestrion:postgres:query:acquire:start'
const PREPARE_START_CHANNEL = 'tracing:orchestrion:postgres:query:prepare:start'

/**
 * @typedef {object} PostgresContext
 * @property {{ span: import('../../..').Span }} currentStore
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
 * @typedef {object} PostgresDbmState
 * @property {string} service
 * @property {string} [statement]
 *
 * @typedef {object} PostgresPreparationContext
 * @property {string} [host]
 * @property {number} [port]
 * @property {boolean} prepared
 * @property {PostgresQuery} query
 * @property {string} [resource]
 * @property {string} statement
 *
 * @typedef {object} PostgresQuery
 *
 * @typedef {object} NativePostgresContext
 * @property {{ span: import('../../..').Span }} currentStore
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

class PostgresPlugin extends DatabasePlugin {
  static id = 'postgres'
  static prefix = 'tracing:orchestrion:postgres:query'

  /** @type {boolean} */
  #dbmEnabled = false

  /** @type {WeakMap<PostgresQuery, PostgresDbmState>} */
  #dbmQueries = new WeakMap()

  /** @type {PostgresPreparationPlugin} */
  #preparation

  /** @type {{ name: string, source: string | undefined }} */
  #service

  /** @type {WeakMap<PostgresQuery, import('../../..').Span>} */
  #spans = new WeakMap()

  /** @type {WeakMap<PostgresQuery, PostgresContext>} */
  #waitContexts = new WeakMap()

  /**
   * @param {object} tracer
   * @param {import('../../dd-trace/src/config/config-base')} tracerConfig
   */
  constructor (tracer, tracerConfig) {
    super(tracer, tracerConfig)
    this.addSub(ACQUIRE_START_CHANNEL, ctx => this.#finishPoolWait(ctx.query))
    this.addBind('tracing:postgres:query:start', ctx => this.#nativeStart(ctx))
    this.addSub('tracing:postgres:query:error', ctx => this.error({ query: ctx, error: ctx.error }))
    this.addSub('tracing:postgres:query:asyncEnd', ctx => this.#nativeEnd(ctx))
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
   * @returns {object}
   */
  bindStart (ctx) {
    this.#waitContexts.set(ctx.query, ctx)
    return this.#start(ctx, ctx.query)
  }

  /**
   * @param {PostgresContext | NativePostgresContext} ctx
   * @param {PostgresQuery} query
   */
  #start (ctx, query) {
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

    this.#spans.set(query, span)
    if (this.#dbmEnabled) {
      this.#dbmQueries.set(query, { service: service.name })
    }
    return ctx.currentStore
  }

  /**
   * @param {NativePostgresContext} ctx
   */
  #nativeStart (ctx) {
    const store = this.#start(ctx, ctx)
    if (typeof ctx.query === 'string') {
      store.span.setTag('resource.name', this.maybeTruncate(ctx.query))
    }
    return store
  }

  /**
   * @param {NativePostgresContext} ctx
   */
  #nativeEnd (ctx) {
    const stream = ctx.result
    if (stream instanceof Readable || stream instanceof Writable) {
      const finish = error => {
        stream.removeListener('end', finish)
        stream.removeListener('finish', finish)
        stream.removeListener('close', finish)
        stream.removeListener(errorMonitor, finish)
        if (error) this.error({ query: ctx, error })
        this.#finishNative(ctx)
      }
      stream.once(errorMonitor, finish)
      stream.once('close', finish)
      stream.once(stream instanceof Readable ? 'end' : 'finish', finish)
    } else {
      this.#finishNative(ctx)
    }
  }

  /**
   * @param {NativePostgresContext} ctx
   */
  #finishNative (ctx) {
    const span = this.#spans.get(ctx)
    if (span === undefined) return

    if (ctx.host !== null) {
      span.addTags({ 'out.host': ctx.host, [CLIENT_PORT_KEY]: ctx.port })
    }
    span.setTag('db.pool.wait_time_ms', ctx.sent === null ? 0 : ctx.sent - ctx.queued)
    this.#end(ctx, ctx.query)
  }

  /**
   * @param {PostgresQuery} query
   */
  #finishPoolWait (query) {
    const ctx = this.#waitContexts.get(query)
    if (ctx === undefined) return

    this.#waitContexts.delete(query)
    ctx.poolWaitFinished = true
    const waitTime = ctx.poolWaitStartMs === undefined ? 0 : performance.now() - ctx.poolWaitStartMs
    ctx.currentStore.span.setTag('db.pool.wait_time_ms', waitTime)
  }

  /**
   * @param {PostgresPreparationContext} ctx
   */
  #prepare (ctx) {
    const state = this.#dbmQueries.get(ctx.query)
    const span = this.#spans.get(ctx.query)
    if (state === undefined || span === undefined) return

    state.statement = ctx.resource ?? ctx.statement
    span.setTag('resource.name', this.maybeTruncate(state.statement))
    if (ctx.host !== undefined) {
      span.addTags({ 'out.host': ctx.host, [CLIENT_PORT_KEY]: ctx.port })
    }
    ctx.statement = this.injectDbmQuery(span, ctx.statement, state.service, ctx.prepared)
  }

  /**
   * @param {Pick<PostgresContext, 'query' | 'error'>} ctx
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
    this.#end(result.query, result.statement, result.pid)
  }

  /**
   * @param {PostgresQuery} query
   * @param {string | null | undefined} statement
   * @param {number} [pid]
   */
  #end (query, statement, pid) {
    const dbmState = this.#dbmQueries.get(query)
    const span = this.#spans.get(query)

    this.#dbmQueries.delete(query)
    if (span === undefined) return

    this.#finishPoolWait(query)
    this.#spans.delete(query)

    if (dbmState?.statement === undefined && typeof statement === 'string') {
      span.setTag('resource.name', this.maybeTruncate(statement))
    }

    span.setTag('db.pid', pid)
    this.finish({ currentStore: { span } })
  }
}

module.exports = PostgresPlugin
