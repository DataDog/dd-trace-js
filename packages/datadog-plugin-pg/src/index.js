'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class PGPlugin extends DatabasePlugin {
  static get id () { return 'pg' }
  static get operation () { return 'query' }
  static get system () { return 'postgres' }

  start ({ params = {}, query, processId }) {
    const service = getServiceName(this.config, params)
    const originalStatement = query.text

    this.startSpan('pg.query', {
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

    query.text = this.injectDbmQuery(query.text, service)
  }
}

function getServiceName (config, params) {
  if (typeof config.service === 'function') {
    return config.service(params)
  }

  return config.service
}

module.exports = PGPlugin
