'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')

/**
 * Build the mysql query span and inject DBM propagation into the SQL.
 *
 * Span/DBM logic used by the retained legacy plugin base for mysql2 and mariadb.
 * This helper subscribes to no channels.
 *
 * The caller must populate `ctx.sql` (the original query text) and `ctx.conf`
 * (the connection config) before calling. On return, `ctx.sql` holds the
 * DBM-injected query and `ctx.currentStore` / `ctx.parentStore` are set by
 * `startSpan`.
 *
 * @param {import('../../dd-trace/src/plugins/database')} plugin
 * @param {{ sql: string, conf: object, currentStore?: object, parentStore?: object }} ctx
 * @returns {object | undefined} the store to enter for the query span
 */
function startQuerySpan (plugin, ctx) {
  const service = plugin.serviceName({ pluginConfig: plugin.config, dbConfig: ctx.conf, system: plugin.system })
  const span = plugin.startSpan(plugin.operationName(), {
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
  }, ctx)
  ctx.sql = plugin.injectDbmQuery(span, ctx.sql, service.name)

  return ctx.currentStore
}

module.exports = { startQuerySpan }
