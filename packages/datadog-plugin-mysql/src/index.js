'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const { resolveHostDetails } = require('../../dd-trace/src/util')

class MySQLPlugin extends DatabasePlugin {
  static get name () { return 'mysql' }
  static get system () { return 'mysql' }

  start ({ sql, conf: dbConfig }) {
    const service = getServiceName(this.config, dbConfig)

    const hostDetails = resolveHostDetails(dbConfig.host)

    this.startSpan(`${this.system}.query`, {
      service,
      resource: sql,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': this.system,
        'db.user': dbConfig.user,
        'db.name': dbConfig.database,
        'network.destination.port': dbConfig.port,
        ...hostDetails
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
