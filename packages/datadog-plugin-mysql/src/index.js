'use strict'

const { storage } = require('../../datadog-core')
const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class MySQLPlugin extends DatabasePlugin {
  static id = 'mysql'
  static system = 'mysql'

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
    ctx.sql = this.injectDbmQuery(span, ctx.sql, service.name)

    return ctx.currentStore
  }
}

module.exports = MySQLPlugin
