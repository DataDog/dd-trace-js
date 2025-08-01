'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class PGPlugin extends DatabasePlugin {
  static id = 'pg'
  static operation = 'query'
  static system = 'postgres'

  start ({ params = {}, query, processId, stream }) {
    const service = this.serviceName({ pluginConfig: this.config, params })
    const originalStatement = this.maybeTruncate(query.text)

    const span = this.startSpan(this.operationName(), {
      service,
      resource: originalStatement,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': 'postgres',
        'db.pid': processId,
        'db.name': params.database,
        'db.user': params.user,
        'out.host': params.host,
        [CLIENT_PORT_KEY]: params.port
      }
    })

    if (stream) {
      span.setTag('db.stream', 1)
    }

    query.__ddInjectableQuery = this.injectDbmQuery(span, query.text, service, !!query.name)
  }
}

module.exports = PGPlugin
