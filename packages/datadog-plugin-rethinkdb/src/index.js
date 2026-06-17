'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class RethinkDBPlugin extends DatabasePlugin {
  static id = 'rethinkdb'
  static system = 'rethinkdb'

  bindStart (ctx) {
    const { db, host, port, query } = ctx

    this.startSpan(this.operationName(), {
      service: this.serviceName({ pluginConfig: this.config }),
      resource: this.maybeTruncate(query),
      type: 'rethinkdb',
      kind: 'client',
      meta: {
        'db.type': 'rethinkdb',
        'db.name': db,
        'out.host': host,
        [CLIENT_PORT_KEY]: port,
      },
    }, ctx)

    return ctx.currentStore
  }
}

module.exports = RethinkDBPlugin
