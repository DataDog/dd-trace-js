'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class MySQLPlugin extends DatabasePlugin {
  static get name () { return 'mysql' }
  static get system () { return 'mysql' }

  start ({ sql, conf: dbConfig }) {
    const service = getServiceName(this.config, dbConfig)
    const sqlStatement = sql[0].sql ? sql[0].sql : sql[0]
    const originalStatement = sqlStatement

    this.startSpan(`${this.system}.query`, {
      service,
      resource: originalStatement,
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
    if (this.config.dbmPropagationMode !== 'disabled') {
      if (sql[0].sql !== undefined) {
        const key = 'sql'
        sql[0][key] = this.injectDbmQuery(sql[0].sql)
      } else sql[0] = this.injectDbmQuery(sql[0])
    }
  }
}

function getServiceName (config, dbConfig) {
  if (typeof config.service === 'function') {
    return config.service(dbConfig)
  }

  return config.service
}

module.exports = MySQLPlugin
