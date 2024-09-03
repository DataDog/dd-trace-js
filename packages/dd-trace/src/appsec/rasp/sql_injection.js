'use strict'

const { pgQueryStart, pgPoolQueryStart, pgPoolQueryFinish } = require('../channels')
const { storage } = require('../../../../datadog-core')
const addresses = require('../addresses')
const waf = require('../waf')
const { RULE_TYPES, handleResult } = require('./utils')

let config

function enable (_config) {
  config = _config

  pgQueryStart.subscribe(analyzePgSqlInjection)
  pgPoolQueryStart.subscribe(analyzePgSqlInjectionInPool)
  pgPoolQueryFinish.subscribe(pgPoolFinish)
}

function disable () {
  if (pgQueryStart.hasSubscribers) pgQueryStart.unsubscribe(analyzePgSqlInjection)
  if (pgPoolQueryStart.hasSubscribers) pgPoolQueryStart.subscribe(analyzePgSqlInjectionInPool)
  if (pgPoolQueryFinish.hasSubscribers) pgPoolQueryFinish.subscribe(pgPoolFinish)
}

function analyzePgSqlInjection (ctx) {
  const query = ctx.query?.text
  if (!query) return

  const store = storage.getStore()
  if (!store) return

  const { raspSqlAnalyzed, req, res } = store

  if (!req || raspSqlAnalyzed) return

  const persistent = {
    [addresses.DB_STATEMENT]: query,
    [addresses.DB_SYSTEM]: 'postgresql' // TODO: Extract to constant
  }

  const result = waf.run({ persistent }, req, RULE_TYPES.SQL_INJECTION)

  handleResult(result, req, res, ctx.abortController, config)
}

function analyzePgSqlInjectionInPool (ctx) {
  const parentStore = storage.getStore()
  if (!parentStore) return

  analyzePgSqlInjection(ctx)

  storage.enterWith({ ...parentStore, raspSqlAnalyzed: true, raspSqlParentStore: parentStore })
}

function pgPoolFinish () {
  const store = storage.getStore()
  if (!store) return
  if (!store.raspSqlParentStore) return

  storage.enterWith(store.raspSqlParentStore)
}

module.exports = { enable, disable }
