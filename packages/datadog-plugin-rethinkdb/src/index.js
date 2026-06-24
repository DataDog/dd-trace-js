'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class RethinkDBPlugin extends DatabasePlugin {
  static id = 'rethinkdb'
  static operation = 'query'
  static system = 'rethinkdb'

  bindStart (ctx) {
    const service = this.serviceName({ pluginConfig: this.config, system: this.system })
    this.startSpan(this.operationName(), {
      service,
      resource: ctx.query,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': this.system,
        'db.name': ctx.db,
        'out.host': ctx.host,
        [CLIENT_PORT_KEY]: ctx.port,
      },
    }, ctx)

    return ctx.currentStore
  }
}

module.exports = RethinkDBPlugin
