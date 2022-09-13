'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class MySQLPlugin extends DatabasePlugin {
  static name = 'mysql'

  start ({ sql, conf: dbConfig }) {
    const service = getServiceName(this.config, dbConfig)

    this.startSpan('mysql.query', {
      service,
      resource: sql,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': 'mysql',
        'db.user': dbConfig.user,
        'db.name': dbConfig.database,
        'out.host': dbConfig.host,
        'out.port': dbConfig.port
      }
    })
  }
}

function getServiceName (config, dbConfig) {
  if (typeof config.service === 'function') {
    return config.service(dbConfig)
  }

  return config.service
}

module.exports = MySQLPlugin
