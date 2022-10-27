'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class PGPlugin extends DatabasePlugin {
  static get name () { return 'pg' }
  static get operation () { return 'query' }
  static get system () { return 'postgres' }

  start ({ params = {}, pgQuery, processId }) {
    const service = getServiceName(this.config, params)
    let originalStatement = pgQuery.text

    if (this.config.sqlInjectionMode === 'service') {
      pgQuery.text = this.createSQLInjectionComment() + pgQuery.text
    }

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
