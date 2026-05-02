'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class PGPlugin extends DatabasePlugin {
  static id = 'pg'
  static operation = 'query'
  static system = 'postgres'

  bindStart (ctx) {
    const { params = {}, query, processId, stream, directAssign } = ctx
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
        [CLIENT_PORT_KEY]: params.port,
      },
    }, ctx)

    if (stream) {
      span.setTag('db.stream', 1)
    }

    const injected = this.injectDbmQuery(span, query.text, service.name, !!query.name)
    if (directAssign) {
      // Writable data property (or no own descriptor); skip the getter trampoline.
      query.text = injected
    } else {
      // Accessor / read-only data; the instrumentation installed a getter that reads this field.
      query.__ddInjectableQuery = injected
    }

    return ctx.currentStore
  }
}

module.exports = PGPlugin
