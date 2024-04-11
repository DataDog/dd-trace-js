'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class TediousPlugin extends DatabasePlugin {
  static get id () { return 'tedious' }
  static get operation () { return 'request' } // TODO: change to match other database plugins
  static get system () { return 'mssql' }

  start ({ queryOrProcedure, connectionConfig }) {
    this.startSpan(this.operationName(), {
      service: this.serviceName({ pluginConfig: this.config, system: this.system }),
      resource: queryOrProcedure,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': 'mssql',
        component: 'tedious',
        'out.host': connectionConfig.server,
        [CLIENT_PORT_KEY]: connectionConfig.options.port,
        'db.user': connectionConfig.userName || connectionConfig.authentication.options.userName,
        'db.name': connectionConfig.options.database,
        'db.instance': connectionConfig.options.instanceName
      }
    })
  }
}

module.exports = TediousPlugin
