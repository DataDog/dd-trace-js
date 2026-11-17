'use strict'

const { performance } = require('node:perf_hooks')

const PostgresBasePlugin = require('./base')

/**
 * @typedef {import('./base').PostgresQuery} PostgresQuery
 * @typedef {import('./base').PostgresContext & {
 *   query: PostgresQuery,
 *   currentStore: import('./base').PostgresStore,
 *   error?: unknown,
 *   pid?: number,
 *   poolWaitFinished?: boolean,
 *   poolWaitStartMs?: number,
 *   statement?: string
 * }} PostgresContext
 */

class PostgresQueryPlugin extends PostgresBasePlugin {
  static prefix = 'tracing:orchestrion:postgres:query'

  /** @type {WeakMap<PostgresQuery, PostgresContext>} */
  #contexts = new WeakMap()

  /**
   * @param {object} tracer
   * @param {import('../../dd-trace/src/config/config-base')} tracerConfig
   */
  constructor (tracer, tracerConfig) {
    super(tracer, tracerConfig)
    this.addSub('tracing:orchestrion:postgres:query:acquire:start', ctx => {
      this.#finishPoolWait(this.#contexts.get(ctx.query))
    })
  }

  /**
   * @param {PostgresContext} ctx
   */
  bindStart (ctx) {
    this.#contexts.set(ctx.query, ctx)
    return super.bindStart(ctx)
  }

  /**
   * @param {PostgresQuery} query
   */
  getStore (query) {
    return this.#contexts.get(query)?.currentStore
  }

  /**
   * @param {PostgresContext | undefined} ctx
   */
  #finishPoolWait (ctx) {
    if (ctx === undefined || ctx.poolWaitFinished) {
      return
    }

    ctx.poolWaitFinished = true
    const waitTime = ctx.poolWaitStartMs === undefined ? 0 : performance.now() - ctx.poolWaitStartMs
    ctx.currentStore.span.setTag('db.pool.wait_time_ms', waitTime)
  }

  /**
   * @param {Pick<PostgresContext, 'query' | 'error'>} ctx
   */
  error (ctx) {
    const span = this.getStore(ctx.query)?.span
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
    if (ctx === undefined) {
      return
    }
    const { currentStore: { span, statement: originalStatement } } = ctx

    this.#finishPoolWait(ctx)
    this.#contexts.delete(query)

    if (originalStatement === undefined && typeof statement === 'string') {
      span.setTag('resource.name', this.maybeTruncate(statement))
    }

    span.setTag('db.pid', pid)
    this.finish(ctx)
  }
}

module.exports = PostgresQueryPlugin
