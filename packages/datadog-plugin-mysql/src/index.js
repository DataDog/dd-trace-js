'use strict'

const { storage } = require('../../datadog-core')
const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class MySQLPlugin extends DatabasePlugin {
  static id = 'mysql'
  static system = 'mysql'

  constructor () {
    super(...arguments)

    this.addSub(`apm:${this.component}:connection:start`, ctx => {
      ctx.parentStore = storage('legacy').getStore()
    })

    this.addBind(`apm:${this.component}:connection:finish`, ctx => ctx.parentStore)

    // An explicit `pool.getConnection()` opens its own short-lived span so the time a caller waits
    // for a busy pool is visible; an acquire that `pool.query()` runs internally reports its wait as
    // a tag on the query span instead (see `bindStart`), so a given acquire is counted once.
    this.addSub(`apm:${this.component}:pool:acquire:start`, ctx => {
      const operation = `${this.component}.pool.acquire`

      ctx.acquireSpan = this.startSpan(operation, {
        service: this.serviceName({ pluginConfig: this.config, dbConfig: ctx.conf, system: this.system }),
        resource: operation,
        type: 'sql',
        kind: 'client',
        meta: {
          'db.type': this.system,
          'db.user': ctx.conf.user,
          'db.name': ctx.conf.database,
          'out.host': ctx.conf.host,
          [CLIENT_PORT_KEY]: ctx.conf.port,
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
