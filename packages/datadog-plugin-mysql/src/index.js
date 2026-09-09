'use strict'

const { storage } = require('../../datadog-core')
const { CLIENT_PORT_KEY, SVC_SRC_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

/**
 * @typedef {{
 *   database?: string,
 *   host?: string,
 *   port?: number,
 *   user?: string
 * }} ConnectionConfig
 */

class MySQLPlugin extends DatabasePlugin {
  static id = 'mysql'
  static system = 'mysql'

  constructor () {
    super(...arguments)

    // Capture into `currentStore` (not `parentStore`) so connection:finish can
    // restore the caller context even when the connection resolves inside an
    // instrumentation skip (a noop store), as the mariadb pool does: the store
    // binding only honors an explicit `currentStore` through a noop store.
    // Without a skip (mysql/mysql2) this is unchanged.
    this.addSub(`apm:${this.component}:connection:start`, ctx => {
      ctx.currentStore = storage('legacy').getStore()
    })

    this.addBind(`apm:${this.component}:connection:finish`, ctx => ctx.currentStore)

    // Explicit getConnection calls get an acquire span. Pool queries report their internal acquire
    // on the query span instead, so each acquire is counted once.
    this.addSub(`apm:${this.component}:pool:acquire:start`, ctx => {
      const operation = `${this.component}.pool.acquire`

      this.startSpan(operation, {
        service: this.serviceName({ pluginConfig: this.config, dbConfig: ctx.conf, system: this.system }),
        resource: operation,
        startTime: ctx.startTime,
        type: 'sql',
        kind: 'client',
        meta: connectionMeta(this.system, ctx.conf),
      }, ctx)
    })

    this.addSub(`apm:${this.component}:pool:acquire:finish`, ctx => {
      const span = ctx.currentStore?.span
      if (span === undefined) return

      if (ctx.error) {
        this.addError(ctx.error, span)
      }
      span.setTag(`${this.component}.pool.wait_time`, ctx.poolWaitTime)
      if (ctx.connectionConfig !== undefined) {
        span.addTags(connectionMeta(this.system, ctx.connectionConfig))
        if (typeof this.config.service === 'function') {
          const service = this.serviceName({
            pluginConfig: this.config,
            dbConfig: ctx.connectionConfig,
            system: this.system,
          })
          if (service.name) {
            this.setServiceName(span, service.name)
            span.setTag(SVC_SRC_KEY, service.source)
          }
        }
      }
      this.finish(ctx)
    })
  }

  bindStart (ctx) {
    const service = this.serviceName({ pluginConfig: this.config, dbConfig: ctx.conf, system: this.system })
    const span = this.startSpan(this.operationName(), {
      service,
      resource: ctx.sql,
      type: 'sql',
      kind: 'client',
      meta: connectionMeta(this.system, ctx.conf),
    }, ctx)

    if (ctx.poolWaitTime !== undefined) {
      span.setTag(`${this.component}.pool.wait_time`, ctx.poolWaitTime)
    }

    ctx.sql = this.injectDbmQuery(span, ctx.sql, service.name)

    return ctx.currentStore
  }
}

/**
 * @param {string} system
 * @param {ConnectionConfig} config
 * @returns {Record<string, string|number|undefined>}
 */
function connectionMeta (system, config) {
  return {
    'db.type': system,
    'db.user': config.user,
    'db.name': config.database,
    'out.host': config.host,
    [CLIENT_PORT_KEY]: config.port,
  }
}

module.exports = MySQLPlugin
