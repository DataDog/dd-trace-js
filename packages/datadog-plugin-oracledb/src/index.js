'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

let parser

class OracledbPlugin extends DatabasePlugin {
  static id = 'oracledb'
  static system = 'oracle'
  static peerServicePrecursors = ['db.instance', 'db.hostname']

  bindStart (ctx) {
    let { query, connAttrs, port, hostname, dbInstance } = ctx

    const service = this.serviceName({ pluginConfig: this.config, params: connAttrs })

    if (hostname === undefined) {
      // Lazy load for performance. This is not needed in v6 and up
      parser ??= require('./connection-parser')
      const dbInfo = parser(connAttrs)
      hostname = dbInfo.hostname
      port ??= dbInfo.port
      dbInstance ??= dbInfo.dbInstance
    }

    // oracledb >= 6.4 accepts `execute({ statement, values })` (sql-template-tag form)
    // in addition to a plain SQL string. Extract the SQL text either way so we can tag
    // the resource and inject DBM into the statement, then re-wrap if needed to keep
    // the caller's binds.
    let sql
    let isObjectForm = false
    if (typeof query === 'string') {
      sql = query
    } else if (typeof query?.statement === 'string') {
      sql = query.statement
      isObjectForm = true
    }

    const span = this.startSpan(this.operationName(), {
      service,
      resource: sql ?? query,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.user': this.config.user,
        'db.instance': dbInstance,
        'db.name': dbInstance,
        'db.hostname': hostname,
        'out.host': hostname,
        [CLIENT_PORT_KEY]: port,
      },
    }, ctx)

    ctx.injected = query
    if (sql !== undefined) {
      const injected = this.injectDbmQuery(span, sql, service.name)
      if (injected !== sql) {
        ctx.injected = isObjectForm ? { ...query, statement: injected } : injected
      }
    }

    return ctx.currentStore
  }
}

module.exports = OracledbPlugin
