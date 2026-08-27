'use strict'

const { storage } = require('../../datadog-core')
const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const {
  configuredDatabaseService,
  configuredServiceWithFunction,
  optionServiceSource,
  storageServiceSource,
} = require('../../dd-trace/src/service-naming/helpers')

/** @type {import('../../dd-trace/src/plugins/tracing').NamingSchema} */
const namingSchema = {
  v0: {
    operationName: () => 'mysql.query',
    serviceName: configuredDatabaseService,
    serviceSource: storageServiceSource('mysql'),
  },
  v1: {
    operationName: () => 'mysql.query',
    serviceName: configuredServiceWithFunction,
    serviceSource: optionServiceSource,
  },
}

class MySQLPlugin extends DatabasePlugin {
  static id = 'mysql'
  static system = 'mysql'

  /** @override */
  getNamingSchema () {
    return namingSchema
  }

  constructor () {
    super(...arguments)

    // Capture into `currentStore` (not `parentStore`) so connection:finish can
    // restore the caller context even when the connection resolves inside an
    // instrumentation skip (a noop store), as the mariadb pool does: the store
    // binding only honors an explicit `currentStore` through a noop store.
    // Without a skip (mysql/mysql2) this is unchanged.
    this.addSub(`apm:${this.component}:connection:start`, ctx => {
      ctx.currentStore = storage('legacy').getStore()
    })

    this.addBind(`apm:${this.component}:connection:finish`, ctx => ctx.currentStore)

    // Explicit getConnection calls get an acquire span. Pool queries report their internal acquire
    // on the query span instead, so each acquire is counted once.
    this.addSub(`apm:${this.component}:pool:acquire:start`, ctx => {
      const operation = `${this.component}.pool.acquire`

      this.startSpan(operation, {
        service: this.serviceName({ pluginConfig: this.config, dbConfig: ctx.conf, system: this.system }),
        resource: operation,
        startTime: ctx.startTime,
        type: 'sql',
        kind: 'client',
        meta: {
          'db.type': this.system,
          'db.user': ctx.conf.user,
          'db.name': ctx.conf.database,
          'out.host': ctx.conf.host,
          [CLIENT_PORT_KEY]: ctx.conf.port,
        },
      }, ctx)
    })

    this.addSub(`apm:${this.component}:pool:acquire:finish`, ctx => {
      const span = ctx.currentStore?.span
      if (span === undefined) return

      if (ctx.error) {
        this.addError(ctx.error, span)
      }
      span.setTag(`${this.component}.pool.wait_time`, ctx.poolWaitTime)
      this.finish(ctx)
    })
  }

  bindStart (ctx) {
    const service = this.serviceName({ pluginConfig: this.config, dbConfig: ctx.conf, system: this.system })
    const span = this.startSpan(this.operationName(), {
      service,
      resource: ctx.sql,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': this.system,
        'db.user': ctx.conf.user,
        'db.name': ctx.conf.database,
        'out.host': ctx.conf.host,
        [CLIENT_PORT_KEY]: ctx.conf.port,
      },
    }, ctx)

    if (ctx.poolWaitTime !== undefined) {
      span.setTag(`${this.component}.pool.wait_time`, ctx.poolWaitTime)
    }

    ctx.sql = this.injectDbmQuery(span, ctx.sql, service.name)

    return ctx.currentStore
  }
}

module.exports = MySQLPlugin
