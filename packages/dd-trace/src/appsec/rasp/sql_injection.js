'use strict'

const {
  pgQueryStart,
  pgPoolQueryStart,
  wafRunFinished,
  mysql2OuterQueryStart,
} = require('../channels')
const addresses = require('../addresses')
const web = require('../../plugins/util/web')
const { getActiveRequest } = require('../store')
const waf = require('../waf')
const { RULE_TYPES, handleResult } = require('./utils')

const DB_SYSTEM_POSTGRES = 'postgresql'
const DB_SYSTEM_MYSQL = 'mysql'
const reqQueryMap = new WeakMap() // WeakMap<Request, Set<querytext>>

let config

function enable (_config) {
  config = _config

  pgQueryStart.subscribe(analyzePgSqlInjection)
  pgPoolQueryStart.subscribe(analyzePgSqlInjection)
  wafRunFinished.subscribe(clearQuerySet)

  mysql2OuterQueryStart.subscribe(analyzeMysql2SqlInjection)
}

function disable () {
  if (pgQueryStart.hasSubscribers) pgQueryStart.unsubscribe(analyzePgSqlInjection)
  if (pgPoolQueryStart.hasSubscribers) pgPoolQueryStart.unsubscribe(analyzePgSqlInjection)
  if (wafRunFinished.hasSubscribers) wafRunFinished.unsubscribe(clearQuerySet)
  if (mysql2OuterQueryStart.hasSubscribers) mysql2OuterQueryStart.unsubscribe(analyzeMysql2SqlInjection)
}

function analyzeMysql2SqlInjection (ctx) {
  const query = ctx.sql
  if (!query) return

  analyzeSqlInjection(query, DB_SYSTEM_MYSQL, ctx.abortController)
}

function analyzePgSqlInjection (ctx) {
  const query = ctx.query?.text
  if (!query) return

  analyzeSqlInjection(query, DB_SYSTEM_POSTGRES, ctx.abortController)
}

function analyzeSqlInjection (query, dbSystem, abortController) {
  const req = getActiveRequest()

  if (!req) return

  let executedQueries = reqQueryMap.get(req)
  if (executedQueries?.has(query)) return

  // Do not waste time checking same query twice
  // This also will prevent double calls in pg.Pool internal queries
  if (!executedQueries) {
    executedQueries = new Set()
    reqQueryMap.set(req, executedQueries)
  }
  executedQueries.add(query)

  const subcontextData = {
    [addresses.DB_STATEMENT]: query,
    [addresses.DB_SYSTEM]: dbSystem,
  }

  const raspRule = { type: RULE_TYPES.SQL_INJECTION }

  const result = waf.runSubContext(subcontextData, raspRule)

  handleResult(result, req, web.getContext(req)?.res, abortController, config, raspRule)
}

function clearQuerySet ({ req, payload }) {
  if (!req || !payload) return

  const executedQueries = reqQueryMap.get(req)
  if (!executedQueries) return

  const hasInput = Object.keys(payload)
    .some(address => address.startsWith('server.request') || address.startsWith('graphql.server'))
  if (hasInput) {
    executedQueries.clear()
  }
}

module.exports = { enable, disable }
