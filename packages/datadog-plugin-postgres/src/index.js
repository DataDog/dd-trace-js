'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class PostgresClientPlugin extends DatabasePlugin {
  static id = 'postgres'
  static operation = 'query'
  static system = 'postgres'

  bindStart (ctx) {
    const { params = {} } = ctx
    const queryText = ctx.query || ''
    const resource = this.maybeTruncate(queryText)
    const service = this.serviceName({ pluginConfig: this.config, params })

    this.startSpan(this.operationName(), {
      service,
      resource,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': 'postgres',
        'db.name': params.database,
        'db.user': params.user,
        'out.host': params.host,
        [CLIENT_PORT_KEY]: params.port
      }
    }, ctx)

    if (this.config.dbmPropagationMode !== 'disabled' && queryText) {
      ctx.injectableQuery = this.injectDbmQuery(ctx.currentStore.span, queryText, service)
    }

    return ctx.currentStore
  }
}

module.exports = PostgresClientPlugin
