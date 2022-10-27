'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class MySQLPlugin extends DatabasePlugin {
  static get name () { return 'mysql' }
  static get system () { return 'mysql' }

  start ({ sql, conf: dbConfig }) {
    const service = getServiceName(this.config, dbConfig)

    this.startSpan(`${this.system}.query`, {
      service,
      resource: sql,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': this.system,
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
