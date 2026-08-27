'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const {
  configuredService,
  configuredSystemService,
  optionServiceSource,
  storageServiceSource,
} = require('../../dd-trace/src/service-naming/helpers')

/** @type {import('../../dd-trace/src/plugins/tracing').NamingSchema} */
const namingSchema = {
  v0: {
    operationName: () => 'tedious.request',
    serviceName: configuredSystemService,
    serviceSource: storageServiceSource('tedious'),
  },
  v1: {
    operationName: () => 'mssql.query',
    serviceName: configuredService,
    serviceSource: optionServiceSource,
  },
}

class TediousPlugin extends DatabasePlugin {
  static id = 'tedious'
  static operation = 'request' // TODO: change to match other database plugins
  static system = 'mssql'

  /** @override */
  getNamingSchema () {
    return namingSchema
  }

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
        'db.instance': ctx.connectionConfig.options.instanceName,
      },
    }, ctx)

    // SQL Server includes comments when caching queries
    // For that reason we allow service mode but not full mode
    ctx.sql = this.injectDbmQuery(span, ctx.queryOrProcedure, service.name, true)
    return ctx.currentStore
  }
}

module.exports = TediousPlugin
