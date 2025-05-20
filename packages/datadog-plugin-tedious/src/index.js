'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class TediousPlugin extends DatabasePlugin {
  static get id () { return 'tedious' }
  static get operation () { return 'request' } // TODO: change to match other database plugins
  static get system () { return 'mssql' }

  bindStart (ctx) {
    const service = this.serviceName({ pluginConfig: this.config, system: this.system })
    const span = this.startSpan(this.operationName(), {
      service,
      resource: ctx.queryOrProcedure,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': 'mssql',
        component: 'tedious',
        'out.host': ctx.connectionConfig.server,
        [CLIENT_PORT_KEY]: ctx.connectionConfig.options.port,
        'db.user': ctx.connectionConfig.userName || ctx.connectionConfig.authentication.options.userName,
        'db.name': ctx.connectionConfig.options.database,
        'db.instance': ctx.connectionConfig.options.instanceName
      }
    }, ctx)

    // SQL Server includes comments when caching queries
    // For that reason we allow service mode but not full mode
    ctx.sql = this.injectDbmQuery(span, ctx.queryOrProcedure, service, true)
    return ctx.currentStore
  }
}

module.exports = TediousPlugin
