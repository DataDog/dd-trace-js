'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class TediousPlugin extends DatabasePlugin {
  static get id () { return 'tedious' }
  static get operation () { return 'request' } // TODO: change to match other database plugins
  static get system () { return 'mssql' }

  start (payload) {
    const service = this.serviceName({ pluginConfig: this.config, system: this.system })
    const span = this.startSpan(this.operationName(), {
      service,
      resource: payload.queryOrProcedure,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': 'mssql',
        component: 'tedious',
        'out.host': payload.connectionConfig.server,
        [CLIENT_PORT_KEY]: payload.connectionConfig.options.port,
        'db.user': payload.connectionConfig.userName || payload.connectionConfig.authentication.options.userName,
        'db.name': payload.connectionConfig.options.database,
        'db.instance': payload.connectionConfig.options.instanceName
      }
    })

    // SQL Server includes comments when caching queries
    // For that reason we allow service mode but not full mode
    payload.sql = this.injectDbmQuery(span, payload.queryOrProcedure, service, true)
  }
}

module.exports = TediousPlugin
