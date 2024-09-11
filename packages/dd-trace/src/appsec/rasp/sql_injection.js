'use strict'

const { pgQueryStart, pgPoolQueryStart, wafRunFinished } = require('../channels')
const { storage } = require('../../../../datadog-core')
const addresses = require('../addresses')
const waf = require('../waf')
const { RULE_TYPES, handleResult } = require('./utils')

const DB_SYSTEM_POSTGRES = 'postgresql'
const reqQueryMap = new WeakMap() // WeakMap<Request, Set<querytext>>

let config

function enable (_config) {
  config = _config

  pgQueryStart.subscribe(analyzePgSqlInjection)
  pgPoolQueryStart.subscribe(analyzePgSqlInjection)
  wafRunFinished.subscribe(clearQuerySet)
}

function disable () {
  if (pgQueryStart.hasSubscribers) pgQueryStart.unsubscribe(analyzePgSqlInjection)
  if (pgPoolQueryStart.hasSubscribers) pgPoolQueryStart.unsubscribe(analyzePgSqlInjection)
  if (wafRunFinished.hasSubscribers) wafRunFinished.unsubscribe(clearQuerySet)
}

function analyzePgSqlInjection (ctx) {
  const query = ctx.query?.text
  if (!query) return

  const store = storage.getStore()
  if (!store) return

  const { req, res } = store

  if (!req) return

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
    [addresses.DB_SYSTEM]: DB_SYSTEM_POSTGRES
  }

  const result = waf.run({ persistent }, req, RULE_TYPES.SQL_INJECTION)

  handleResult(result, req, res, ctx.abortController, config)
}

function hasInputAddress (payload) {
  return hasAddressesObjectInputAddress(payload.ephemeral) || hasAddressesObjectInputAddress(payload.persistent)
}

function hasAddressesObjectInputAddress (addressesObject) {
  return addressesObject && Object.keys(addressesObject)
    .some(address => address.startsWith('server.request') || address.startsWith('graphql.server'))
}

function clearQuerySet ({ payload }) {
  if (!payload) return

  const store = storage.getStore()
  if (!store) return

  const { req } = store
  if (!req) return

  const executedQueries = reqQueryMap.get(req)
  if (!executedQueries) return

  if (hasInputAddress(payload)) {
    executedQueries.clear()
  }
}

module.exports = { enable, disable }
