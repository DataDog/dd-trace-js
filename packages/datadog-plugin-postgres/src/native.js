'use strict'

const { Readable, Writable } = require('node:stream')

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const PostgresBasePlugin = require('./base')

/**
 * @typedef {import('./base').PostgresContext & {
 *   query: string | null,
 *   error?: Error,
 *   queued: number,
 *   result?: unknown,
 *   sent: number | null
 * }} NativePostgresContext
 *
 * @typedef {object} PostgresCopyContext
 * @property {Error | null} error
 * @property {NativePostgresContext} query
 */

class PostgresCopyPlugin extends Plugin {
  static id = 'postgres'

  /**
   * @param {(ctx: PostgresCopyContext) => void} finish
   * @param {object} tracer
   * @param {import('../../dd-trace/src/config/config-base')} tracerConfig
   */
  constructor (finish, tracer, tracerConfig) {
    super(tracer, tracerConfig)
    this.addSub('tracing:orchestrion:postgres:query:copy:start', finish)
  }
}

class PostgresNativePlugin extends PostgresBasePlugin {
  static prefix = 'tracing:postgres:query'

  /**
   * @param {object} tracer
   * @param {import('../../dd-trace/src/config/config-base')} tracerConfig
   */
  constructor (tracer, tracerConfig) {
    super(tracer, tracerConfig)
    const copy = new PostgresCopyPlugin(ctx => {
      const store = ctx.query.currentStore
      if (store === undefined) {
        return
      }
      if (ctx.error) {
        this.addError(ctx.error, store.span)
      }
      this.#finish(ctx.query)
    }, tracer, tracerConfig)
    // Complete in-flight COPY spans even after this plugin is disabled.
    copy.configure(true)
  }

  /**
   * @param {NativePostgresContext} ctx
   */
  bindStart (ctx) {
    const store = super.bindStart(ctx)
    if (typeof ctx.query === 'string') {
      store.span.setTag('resource.name', this.maybeTruncate(ctx.query))
    }
    return store
  }

  /**
   * @param {NativePostgresContext} ctx
   */
  error (ctx) {
    if (ctx.currentStore) {
      this.addError(ctx.error, ctx.currentStore.span)
    }
  }

  /**
   * @param {NativePostgresContext} ctx
   */
  asyncEnd (ctx) {
    if (!(ctx.result instanceof Readable || ctx.result instanceof Writable)) {
      this.#finish(ctx)
    }
  }

  /**
   * @param {NativePostgresContext} ctx
   */
  #finish (ctx) {
    const store = ctx.currentStore
    if (store === undefined) {
      return
    }
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
}

module.exports = PostgresNativePlugin
