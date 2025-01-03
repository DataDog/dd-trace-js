'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class TediousPlugin extends DatabasePlugin {
  static get id () { return 'tedious' }
  static get system () { return 'mssql' }

  start (payload) {
    const service =
    this.serviceName({ pluginConfig: this.config, dbConfig: payload.connectionConfig, system: this.system })

    const span = this.startSpan(this.operationName(), {
      service,
      resource: payload.queryOrProcedure,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': 'mssql',
        component: 'tedious',
        'out.host': 'DEV8B',
        [CLIENT_PORT_KEY]: payload.connectionConfig.options.port,
        'db.user': payload.connectionConfig.userName || payload.connectionConfig.authentication.options.userName,
        'db.name': payload.connectionConfig.options.database,
        'db.instance': payload.connectionConfig.options.instanceName
      }
    })

    payload.queryOrProcedure = this.injectDbmQuery(span, payload.queryOrProcedure, service)
  }
}

module.exports = TediousPlugin
