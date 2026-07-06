'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')

/**
 * Build a SQL query span and inject DBM propagation into the SQL.
 *
 * This helper owns only the common database span shape. It does not subscribe
 * to diagnostic channels or make assumptions about a library's hook lifecycle.
 *
 * @param {import('../../dd-trace/src/plugins/database')} plugin
 * @param {{
 *   sql: string,
 *   conf: { user?: string, database?: string, host?: string, port?: number },
 *   currentStore?: object,
 *   parentStore?: object
 * }} ctx
 * @param {{ childOf?: object | null }} [options]
 * @returns {object | undefined} the store to enter for the query span
 */
function startQuerySpan (plugin, ctx, options = {}) {
  const service = plugin.serviceName({ pluginConfig: plugin.config, dbConfig: ctx.conf, system: plugin.system })
  const startOptions = {
    service,
    resource: ctx.sql,
    type: 'sql',
    kind: 'client',
    meta: {
      'db.type': plugin.system,
      'db.user': ctx.conf.user,
      'db.name': ctx.conf.database,
      'out.host': ctx.conf.host,
      [CLIENT_PORT_KEY]: ctx.conf.port,
    },
  }

  if (options.childOf !== undefined) {
    startOptions.childOf = options.childOf
  }

  const span = plugin.startSpan(plugin.operationName(), startOptions, ctx)
  ctx.sql = plugin.injectDbmQuery(span, ctx.sql, service.name)

  return ctx.currentStore
}

module.exports = {
  startQuerySpan,
}
