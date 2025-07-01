'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class OracledbPlugin extends DatabasePlugin {
  static get id () { return 'oracledb' }
  static get system () { return 'oracle' }
  static get peerServicePrecursors () { return ['db.instance', 'db.hostname'] }

  start ({ query, connAttrs }) {
    const service = this.serviceName({ pluginConfig: this.config, params: connAttrs })

    const lastCollonIndex = connAttrs.dbRemoteAddress.lastIndexOf(':')
    const port = connAttrs.dbRemoteAddress.slice(lastCollonIndex + 1)
    const hostname = connAttrs.dbRemoteAddress.slice(0, lastCollonIndex)

    this.startSpan(this.operationName(), {
      service,
      resource: query,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.user': this.config.user,
        'db.instance': connAttrs.dbInstance,
        'db.hostname': hostname,
        [CLIENT_PORT_KEY]: port
      }
    })
  }
}

module.exports = OracledbPlugin
