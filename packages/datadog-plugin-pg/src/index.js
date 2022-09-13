'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class PGPlugin extends DatabasePlugin {
  static name = 'pg'

  operation = 'query'
  system = 'postgres'

  start ({ params = {}, statement }) {
    const service = getServiceName(this.config, params)

    this.startSpan('pg.query', {
      service,
      resource: statement,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': 'postgres',
        'db.name': params.database,
        'db.user': params.user,
        'out.host': params.host,
        'out.port': params.port
      }
    })
  }
}

function getServiceName (config, params) {
  if (typeof config.service === 'function') {
    return config.service(params)
  }

  return config.service
}

module.exports = PGPlugin
