'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class MySQL2Plugin extends DatabasePlugin {
  static get name () { return 'mysql2' }
  static get system () { return 'mysql' }

  start ({ sqlStatement, sql, conf: dbConfig }) {
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
    if (this.config.dbmPropagationMode !== 'disabled') {
      if (sqlStatement.statement !== undefined) {
        sqlStatement.statement.query = this.injectDbmQuery(sqlStatement.statement.query)
      } else if (sqlStatement.sql) {
        sqlStatement.sql = this.injectDbmQuery(sqlStatement.sql)
      }
    }
  }
}

function getServiceName (config, dbConfig) {
  if (typeof config.service === 'function') {
    return config.service(dbConfig)
  }

  return config.service
}

module.exports = MySQL2Plugin
