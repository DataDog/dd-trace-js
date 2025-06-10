'use strict'

const { storage } = require('../../datadog-core')
const CLIENT_PORT_KEY = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class MySQLPlugin extends DatabasePlugin {
  static get id () { return 'mysql' }
  static get system () { return 'mysql' }

  constructor () {
    super(...arguments)

    this.addSub(`apm:${this.component}:connection:start`, ctx => {
      ctx.parentStore = storage('legacy').getStore()
    })

    this.addBind(`apm:${this.component}:connection:finish`, ctx => ctx.parentStore)
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
        [CLIENT_PORT_KEY]: ctx.conf.port
      }
    }, ctx)
    ctx.sql = this.injectDbmQuery(span, ctx.sql, service)

    return ctx.currentStore
  }
}

module.exports = MySQLPlugin
