'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class OracledbPlugin extends DatabasePlugin {
  static get id () { return 'oracledb' }
  static get system () { return 'oracle' }
  static get peerServicePrecursors () { return ['db.instance', 'db.hostname'] }

  start ({ query, connAttrs, port, hostname, dbInstance }) {
    let service = this.serviceName({ pluginConfig: this.config, params: connAttrs })

    if (service === undefined && hostname) {
      // Fallback for users not providing the service properly in a serviceName method
      service = `${hostname}:${port}/${dbInstance}`
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
    })
  }
}

module.exports = OracledbPlugin
