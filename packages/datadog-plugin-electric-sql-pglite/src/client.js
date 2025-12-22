'use strict'

const { storage } = require('../../datadog-core')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class BasePgliteQueryPlugin extends DatabasePlugin {
  static id = 'electric-sql-pglite-query'
  static operation = 'query'
  static system = 'postgres'
  static prefix = 'tracing:orchestrion:@electric-sql/pglite:BasePGlite_query'

  bindStart (ctx) {
    const statement = ctx.arguments?.[0] || ''
    const service = this.serviceName({ pluginConfig: this.config })

    const span = this.startSpan('electric-sql-pglite.query', {
      service,
      resource: this.maybeTruncate(statement),
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': 'postgres',
        'db.name': 'postgres',
        'db.statement': this.maybeTruncate(statement),
        component: 'electric-sql-pglite'
      }
    }, ctx)

    const store = storage('legacy').getStore() || {}
    ctx.currentStore = { ...store, span }

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore.span
    if (span) {
      this.endSpan(span)
    }
  }
}

class BasePgliteExecPlugin extends DatabasePlugin {
  static id = 'electric-sql-pglite-exec'
  static operation = 'exec'
  static system = 'postgres'
  static prefix = 'tracing:orchestrion:@electric-sql/pglite:BasePGlite_exec'

  bindStart (ctx) {
    const statement = ctx.arguments?.[0] || ''
    const service = this.serviceName({ pluginConfig: this.config })

    const span = this.startSpan('electric-sql-pglite.exec', {
      service,
      resource: this.maybeTruncate(statement),
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': 'postgres',
        'db.name': 'postgres',
        'db.statement': this.maybeTruncate(statement),
        component: 'electric-sql-pglite'
      }
    }, ctx)

    const store = storage('legacy').getStore() || {}
    ctx.currentStore = { ...store, span }

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore.span
    if (span) {
      this.endSpan(span)
    }
  }
}

class BasePgliteTransactionPlugin extends DatabasePlugin {
  static id = 'electric-sql-pglite-transaction'
  static operation = 'transaction'
  static system = 'postgres'
  static prefix = 'tracing:orchestrion:@electric-sql/pglite:BasePGlite_transaction'

  bindStart (ctx) {
    const service = this.serviceName({ pluginConfig: this.config })

    const span = this.startSpan('electric-sql-pglite.transaction', {
      service,
      resource: 'transaction',
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': 'postgres',
        'db.name': 'postgres',
        component: 'electric-sql-pglite'
      }
    }, ctx)

    const store = storage('legacy').getStore() || {}
    ctx.currentStore = { ...store, span }

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore.span
    if (span) {
      this.endSpan(span)
    }
  }
}

module.exports = [BasePgliteQueryPlugin, BasePgliteExecPlugin, BasePgliteTransactionPlugin]
