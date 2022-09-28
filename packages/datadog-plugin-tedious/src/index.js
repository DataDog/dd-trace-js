'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class TediousPlugin extends DatabasePlugin {
  static get name () { return 'tedious' }
  static get operation () { return 'request' } // TODO: change to match other database plugins
  static get system () { return 'mssql' }

  start ({ queryOrProcedure, connectionConfig }) {
    this.startSpan('tedious.request', {
      service: this.config.service,
      resource: queryOrProcedure,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': 'mssql',
        'component': 'tedious',
        'out.host': connectionConfig.server,
        'out.port': connectionConfig.options.port,
        'db.user': connectionConfig.userName || connectionConfig.authentication.options.userName,
        'db.name': connectionConfig.options.database,
        'db.instance': connectionConfig.options.instanceName
      }
    })
  }
}

module.exports = TediousPlugin
