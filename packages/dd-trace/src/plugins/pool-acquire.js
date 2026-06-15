'use strict'

const { CLIENT_PORT_KEY } = require('../constants')
const DatabasePlugin = require('./database')

// Query builders / ORMs identify their backend by a dialect or driver name that does not always match
// the Datadog `db.type`. Map the ones that differ; everything already aligned (mysql, postgres, sqlite,
// mariadb, mssql, ...) passes through unchanged.
const DB_SYSTEMS = new Map([
  ['postgresql', 'postgres'],
  ['pg', 'postgres'],
  ['pg-native', 'postgres'],
  ['cockroachdb', 'postgres'],
  ['redshift', 'postgres'],
  ['mysql2', 'mysql'],
  ['sqlite3', 'sqlite'],
  ['better-sqlite3', 'sqlite'],
  ['oracledb', 'oracle'],
  ['tedious', 'mssql'],
])

/**
 * Shared base for integrations that own a connection pool and expose connection acquisition as a
 * distinct, awaitable step (knex over tarn, sequelize over sequelize-pool). The instrumentation only
 * publishes when a caller actually waits for a connection, so the span measures pool-wait time
 * without the query itself.
 */
class PoolAcquirePlugin extends DatabasePlugin {
  constructor () {
    super(...arguments)

    this.addSub(`apm:${this.component}:pool:acquire:start`, ctx => {
      const conf = ctx.conf ?? {}
      const operation = `${this.component}.pool.acquire`

      ctx.acquireSpan = this.startSpan(operation, {
        service: this.serviceName({ pluginConfig: this.config }),
        resource: operation,
        type: 'sql',
        kind: 'client',
        meta: {
          'db.type': DB_SYSTEMS.get(ctx.dialect) ?? ctx.dialect,
          'db.user': conf.user,
          'db.name': conf.database,
          'out.host': conf.host,
          [CLIENT_PORT_KEY]: conf.port,
        },
      }, false)
    })

    this.addSub(`apm:${this.component}:pool:acquire:finish`, ctx => {
      const span = ctx.acquireSpan

      if (ctx.error) {
        this.addError(ctx.error, span)
      }
      span.setTag(`${this.component}.pool.wait_time`, ctx.poolWaitTime)
      span.finish()
    })
  }
}

module.exports = PoolAcquirePlugin
