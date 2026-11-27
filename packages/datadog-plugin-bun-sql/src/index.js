'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class BunSQLPlugin extends DatabasePlugin {
  static id = 'bun-sql'

  /**
   * @param {{ statement: string, adapter: string, hostname?: string, port?: number,
   * database?: string, username?: string, prepared: boolean, currentStore?: object }} ctx
   * @returns {object | undefined}
   */
  bindStart (ctx) {
    const { statement, adapter, hostname, port, database, username, prepared } = ctx
    const service = this.serviceName({ pluginConfig: this.config, system: adapter })
    const span = this.startSpan(this.operationName({ system: adapter }), {
      service,
      resource: this.maybeTruncate(statement),
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': adapter,
        'db.name': database,
        'db.user': username,
        'out.host': hostname,
        [CLIENT_PORT_KEY]: port,
      },
    }, ctx)

    if (adapter === 'postgres' || adapter === 'mysql') {
      ctx.statement = this.injectDbmQuery(span, statement, service.name, prepared)
    }
    return ctx.currentStore
  }
}

module.exports = BunSQLPlugin
