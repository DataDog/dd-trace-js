'use strict'

const CLIENT_PORT_KEY = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class MySQLPlugin extends DatabasePlugin {
  static get id () { return 'mysql' }
  static get system () { return 'mysql' }

  start (payload) {
    const service = this.serviceName({ pluginConfig: this.config, dbConfig: payload.conf, system: this.system })
    const span = this.startSpan(this.operationName(), {
      service,
      resource: payload.sql,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': this.system,
        'db.user': payload.conf.user,
        'db.name': payload.conf.database,
        'out.host': payload.conf.host,
        [CLIENT_PORT_KEY]: payload.conf.port
      }
    })
    payload.sql = this.injectDbmQuery(span, payload.sql, service)
  }
}

module.exports = MySQLPlugin
