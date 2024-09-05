'use strict'

const { pgQueryStart, pgPoolQueryStart } = require('../channels')
const { storage } = require('../../../../datadog-core')
const addresses = require('../addresses')
const waf = require('../waf')
const { RULE_TYPES, handleResult } = require('./utils')

let config
const reqQueryMap = new WeakMap() // WeakMap<Request, Set<querystring>>
function enable (_config) {
  config = _config

  pgQueryStart.subscribe(analyzePgSqlInjection)
  pgPoolQueryStart.subscribe(analyzePgSqlInjection)
}

function disable () {
  if (pgQueryStart.hasSubscribers) pgQueryStart.unsubscribe(analyzePgSqlInjection)
  if (pgPoolQueryStart.hasSubscribers) pgPoolQueryStart.subscribe(analyzePgSqlInjection)
}

function analyzePgSqlInjection (ctx) {
  const query = ctx.query?.text
  if (!query) return

  const store = storage.getStore()
  if (!store) return

  const { raspSqlAnalyzed, req, res } = store

  if (!req || raspSqlAnalyzed) return

  let executedQueries = reqQueryMap.get(req)
  if (executedQueries?.has(query)) return

  // Do not waste time executing same query twice
  // This also will prevent double calls in pg.Pool internal queries
  if (!executedQueries) {
    executedQueries = new Set()
    reqQueryMap.set(req, executedQueries)
  }
  executedQueries.add(query)

  const persistent = {
    [addresses.DB_STATEMENT]: query,
    [addresses.DB_SYSTEM]: 'postgresql' // TODO: Extract to constant
  }

  const result = waf.run({ persistent }, req, RULE_TYPES.SQL_INJECTION)

  handleResult(result, req, res, ctx.abortController, config)
}

module.exports = { enable, disable }
