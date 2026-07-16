'use strict'

const { CLIENT_PORT_KEY } = require('../../constants')
const DatabasePlugin = require('../../plugins/database')

/**
 * Shared processor for normalized database query lifecycle events.
 *
 * Source adapters own package-specific argument and completion handling. This
 * processor owns Datadog query span semantics and DBM propagation.
 */
class DatabaseQueryProcessor extends DatabasePlugin {
  static prefix = 'tracing:datadog:db:query'

  bindStart (event) {
    const data = event.data
    const source = event.source
    const system = source.system
    const connection = data.connection
    const service = this.serviceName({
      pluginConfig: this.config,
      dbConfig: connection,
      system,
      id: source.integration,
    })
    const span = this.startSpan(this.operationName({ id: source.integration }), {
      component: source.integration,
      integrationName: source.integration,
      service,
      resource: data.statement,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': system,
        'db.user': connection.user,
        'db.name': connection.database,
        'out.host': connection.host,
        [CLIENT_PORT_KEY]: connection.port,
      },
    }, event)

    data.statement = this.injectDbmQuery(span, data.statement, service.name)
    event.context = {
      parentStore: event.parentStore,
      currentStore: event.currentStore,
      span,
    }

    return event.currentStore
  }
}

module.exports = DatabaseQueryProcessor
