'use strict'

const { SQL_INJECTION } = require('../vulnerabilities')
const { getRanges } = require('../taint-tracking/operations')
const { storage } = require('../../../../../datadog-core')
const { getNodeModulesPaths } = require('../path-line')
const StoredInjectionAnalyzer = require('./stored-injection-analyzer')

const EXCLUDED_PATHS = getNodeModulesPaths('mysql', 'mysql2', 'sequelize', 'pg-pool', 'knex')

/**
 * @typedef {object} MysqlOrchestrionContext
 * @property {Array<unknown>} arguments
 * @property {unknown} [result]
 * @property {unknown} [sql]
 * @property {boolean} [iastSqlAnalyzed]
 */

/**
 * @param {MysqlOrchestrionContext} ctx
 * @returns {unknown}
 */
function getMysqlOrchestrionSql (ctx) {
  const firstArg = ctx.arguments?.[0]

  return firstArg?.sql || firstArg
}

class SqlInjectionAnalyzer extends StoredInjectionAnalyzer {
  constructor () {
    super(SQL_INJECTION)
  }

  onConfigure () {
    this.addSub('apm:mysql:query:start', ({ sql }) => this.analyze(sql, undefined, 'MYSQL'))
    this.addSub(
      'tracing:orchestrion:mysql:Connection_query:start',
      ctx => this.analyzeMysqlOrchestrionConnectionQuery(ctx)
    )
    this.addSub('datadog:mysql2:outerquery:start', ({ sql }) => this.analyze(sql, undefined, 'MYSQL'))
    this.addSub(
      'apm:pg:query:start',
      ({ originalText, query }) => this.analyze(originalText || query.text, undefined, 'POSTGRES')
    )

    this.addBind(
      'datadog:sequelize:query:start',
      ({ sql, dialect }) => this.getStoreAndAnalyze(sql, dialect.toUpperCase())
    )
    this.addSub('datadog:sequelize:query:finish', () => this.returnToParentStore())

    this.addBind('datadog:pg:pool:query:start', ({ query }) => this.getStoreAndAnalyze(query.text, 'POSTGRES'))
    this.addSub('datadog:pg:pool:query:finish', () => this.returnToParentStore())

    this.addSub('datadog:mysql:pool:query:start', ({ sql }) => this.setStoreAndAnalyzeIfNeeded(sql, 'MYSQL'))
    this.addSub('datadog:mysql:pool:query:finish', () => this.returnToParentStore())
    this.addBind(
      'tracing:orchestrion:mysql:Pool_query:start',
      ctx => this.bindMysqlOrchestrionPoolQuery(ctx)
    )
    this.addSub(
      'tracing:orchestrion:mysql:Pool_query:end',
      ctx => this.finishMysqlOrchestrionPoolQuery(ctx)
    )

    this.addBind('datadog:knex:raw:start', (context) => {
      const { sql, dialect: knexDialect } = context
      const dialect = this.normalizeKnexDialect(knexDialect)
      const currentStore = this.getStoreAndAnalyze(sql, dialect)
      context.currentStore = currentStore
      return currentStore
    })

    this.addBind('datadog:knex:raw:subscribes', ({ currentStore }) => currentStore)
    this.addBind('datadog:knex:raw:finish', ({ currentStore }) => currentStore?.sqlParentStore)
  }

  setStoreAndAnalyze (query, dialect) {
    const store = this.getStoreAndAnalyze(query, dialect)

    if (store) {
      storage('legacy').enterWith(store)
    }

    return store
  }

  /**
   * Enter a SQL-analyzed store unless a parent pool-query hook already did it.
   *
   * @param {unknown} query
   * @param {string} dialect
   * @returns {object|undefined}
   */
  setStoreAndAnalyzeIfNeeded (query, dialect) {
    const store = storage('legacy').getStore()
    if (store?.sqlAnalyzed) return store

    return this.setStoreAndAnalyze(query, dialect)
  }

  getStoreAndAnalyze (query, dialect) {
    const parentStore = storage('legacy').getStore()
    if (parentStore) {
      this.analyze(query, parentStore, dialect)

      return { ...parentStore, sqlAnalyzed: true, sqlParentStore: parentStore }
    }
  }

  returnToParentStore (store = storage('legacy').getStore()) {
    if (store && store.sqlParentStore) {
      storage('legacy').enterWith(store.sqlParentStore)
    }
  }

  /**
   * Analyze Orchestrion mysql connection queries when the APM plugin is not configured.
   *
   * The mysql APM plugin republishes the legacy `apm:mysql:query:start` channel
   * from its bind hook. When that path ran, `ctx.sql` is already populated and
   * the legacy subscriber above has handled the original SQL text.
   *
   * @param {MysqlOrchestrionContext} ctx
   * @returns {void}
   */
  analyzeMysqlOrchestrionConnectionQuery (ctx) {
    if (ctx.sql !== undefined) return

    this.analyze(getMysqlOrchestrionSql(ctx), undefined, 'MYSQL')
  }

  /**
   * Bind the IAST SQL-analyzed store around Orchestrion mysql pool queries.
   *
   * Pool queries dispatch into `Connection.query`, so the analyzed store must be
   * active while the original pool method executes. The APM plugin also
   * republishes the legacy pool channel from its bind hook; `ctx.sql` or an
   * existing `sqlAnalyzed` store means that path has already run.
   *
   * @param {MysqlOrchestrionContext} ctx
   * @returns {object|undefined}
   */
  bindMysqlOrchestrionPoolQuery (ctx) {
    const currentStore = storage('legacy').getStore()
    if (ctx.sql !== undefined || currentStore?.sqlAnalyzed) return currentStore

    const store = this.getStoreAndAnalyze(getMysqlOrchestrionSql(ctx), 'MYSQL')
    if (!store) return

    ctx.iastSqlAnalyzed = true

    const args = ctx.arguments
    const callback = args[args.length - 1]
    if (typeof callback === 'function') {
      const analyzer = this
      args[args.length - 1] = function () {
        analyzer.returnToParentStore()

        return callback.apply(this, arguments)
      }
    }

    return store
  }

  /**
   * Restore the parent IAST store when an Orchestrion mysql pool query returns a thenable.
   *
   * @param {MysqlOrchestrionContext} ctx
   * @returns {void}
   */
  finishMysqlOrchestrionPoolQuery (ctx) {
    if (!ctx.iastSqlAnalyzed) return

    const result = ctx.result
    if (result && typeof result.then === 'function') {
      const finish = () => this.returnToParentStore()
      result.then(finish, finish)
    }
  }

  _getEvidence (value, iastContext, dialect) {
    const ranges = getRanges(iastContext, value)
    return { value, ranges, dialect }
  }

  analyze (value, store, dialect) {
    store = store || storage('legacy').getStore()
    if (!(store && store.sqlAnalyzed)) {
      super.analyze(value, store, dialect)
    }
  }

  _getExcludedPaths () {
    return EXCLUDED_PATHS
  }

  normalizeKnexDialect (knexDialect) {
    if (knexDialect === 'postgresql') {
      return 'POSTGRES'
    }

    if (knexDialect === 'sqlite3') {
      return 'SQLITE'
    }

    if (typeof knexDialect === 'string') {
      return knexDialect.toUpperCase()
    }
  }
}

module.exports = new SqlInjectionAnalyzer()
