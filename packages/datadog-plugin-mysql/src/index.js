'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class MySQLPlugin extends DatabasePlugin {
  static get name () { return 'mysql' }
  static get system () { return 'mysql' }

  start (payload) {
    const service = getServiceName(this.config, payload.conf)

    this.startSpan(`${this.system}.query`, {
      service,
      resource: payload.sql,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': this.system,
        'db.user': payload.conf.user,
        'db.name': payload.conf.database,
        'out.host': payload.conf.host,
        'out.port': payload.conf.port
      }
    })
    payload.sql = this.injectDbmQuery(payload.sql, service)
  }
}

function getServiceName (config, dbConfig) {
  if (typeof config.service === 'function') {
    return config.service(dbConfig)
  }

  return config.service
}

module.exports = MySQLPlugin
