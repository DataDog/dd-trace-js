'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

let parser

class OracledbPlugin extends DatabasePlugin {
  static id = 'oracledb'
  static system = 'oracle'
  static peerServicePrecursors = ['db.instance', 'db.hostname']

  bindStart (ctx) {
    let { query, connAttrs, port, hostname, dbInstance } = ctx

    const service = this.serviceName({ pluginConfig: this.config, params: connAttrs })

    if (hostname === undefined) {
      // Lazy load for performance. This is not needed in v6 and up
      parser ??= require('./connection-parser')
      const dbInfo = parser(connAttrs)
      hostname = dbInfo.hostname
      port ??= dbInfo.port
      dbInstance ??= dbInfo.dbInstance
    }

    this.startSpan(this.operationName(), {
      service,
      resource: query,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.user': this.config.user,
        'db.instance': dbInstance,
        'db.hostname': hostname,
        [CLIENT_PORT_KEY]: port,
      }
    }, ctx)

    return ctx.currentStore
  }
}

module.exports = OracledbPlugin
