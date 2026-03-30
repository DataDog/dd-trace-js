'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class MariadbQueryPlugin extends DatabasePlugin {
  static id = 'mariadb'
  static system = 'mariadb'
  static operation = 'query'

  /**
   * Extract connection config from the connection/pool instance.
   * The createConnection/createPool channel handlers store the raw opts on
   * the instance as `__ddConf`.
   *
   * @param {object} self - The connection or pool instance (ctx.self)
   * @returns {{ host?: string, user?: string, database?: string, port?: number }}
   */
  getConf (self) {
    return self?.__ddConf || {}
  }

  bindStart (ctx) {
    const conf = this.getConf(ctx.self)
    const sql = ctx.arguments?.[0]
    const service = this.serviceName({ pluginConfig: this.config, dbConfig: conf, system: this.system })

    const span = this.startSpan(this.operationName(), {
      service,
      resource: sql,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': this.system,
        'db.user': conf.user,
        'db.name': conf.database,
        'out.host': conf.host,
        [CLIENT_PORT_KEY]: conf.port,
      },
    }, ctx)

    ctx.sql = this.injectDbmQuery(span, sql, service)

    return ctx.currentStore
  }

  /**
   * Restore the parent async context when the callback/promise result arrives,
   * so that user code inside the callback sees the same active span as before
   * the query was called (rather than the DB span context).
   *
   * @param {object} ctx - Orchestrion channel context
   * @returns {object} parentStore - the store active when bindStart ran
   */
  bindAsyncStart (ctx) {
    return ctx.parentStore
  }

  /**
   * Finish the span when the async operation completes.
   * Tag peer.service before finishing since the orchestrion wrappers never
   * fire the 'finish' channel that OutboundPlugin.finish() listens to.
   *
   * @param {object} ctx - Orchestrion channel context
   */
  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    if (span) {
      this.tagPeerService(span)
      span.finish()
    }
  }
}

class ConnectionCallbackQueryPlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:ConnectionCallback_query'
}

class ConnectionCallbackExecutePlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:ConnectionCallback_execute'
}

class ConnectionPromiseQueryPlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:ConnectionPromise_query'
}

class ConnectionPromiseExecutePlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:ConnectionPromise_execute'
}

class PoolCallbackQueryPlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:PoolCallback_query'
}

class PoolCallbackExecutePlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:PoolCallback_execute'
}

class PoolPromiseQueryPlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:PoolPromise_query'
}

class PoolPromiseExecutePlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:PoolPromise_execute'
}

// -------------------------------------------------------------------------
// v<3 query plugins — channels from thisPropertyName orchestrion entries
// -------------------------------------------------------------------------

class V2ConnectionQueryPromisePlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:v2Connection_queryPromise'
}

class V2ConnectionQueryPlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:v2Connection_query'
}

class V2ConnectionQueryCallbackPlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:v2Connection_queryCallback'
}

class V2PoolBaseQueryPlugin extends MariadbQueryPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:v2PoolBase_query'
}

// -------------------------------------------------------------------------
// PreparedStatement execute — statement.execute(values, [opts], [cb])
// ctx.self is PrepareWrapper: .query = SQL, .conn.opts = connection options
// -------------------------------------------------------------------------

class PreparedStatementExecutePlugin extends MariadbQueryPlugin {
  static id = 'mariadb'

  /**
   * For prepared statement execution, connection options live on the
   * internal connection object. Two layouts across v3 minor versions:
   *   v3.4.x+: ctx.self is PrepareWrapper  → self.conn.opts
   *   v3.0.x:  ctx.self is PrepareResultPacket → self.emitter.opts
   *
   * @param {object} self - PrepareWrapper or PrepareResultPacket (ctx.self)
   * @returns {{ host?: string, user?: string, database?: string, port?: number }}
   */
  getConf (self) {
    const opts = self?.conn?.opts ?? self?.emitter?.opts
    if (!opts) return {}
    return {
      host: opts.host,
      user: opts.user,
      database: opts.database,
      port: opts.port,
    }
  }

  bindStart (ctx) {
    const conf = this.getConf(ctx.self)
    const sql = ctx.self?.query
    const service = this.serviceName({ pluginConfig: this.config, dbConfig: conf, system: this.system })

    const span = this.startSpan(this.operationName(), {
      service,
      resource: sql,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': this.system,
        'db.user': conf.user,
        'db.name': conf.database,
        'out.host': conf.host,
        [CLIENT_PORT_KEY]: conf.port,
      },
    }, ctx)

    ctx.sql = this.injectDbmQuery(span, sql, service)
    return ctx.currentStore
  }
}

class PreparedStatementCallbackExecutePlugin extends PreparedStatementExecutePlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:PrepareResultPacket_execute'
}

module.exports = [
  ConnectionCallbackQueryPlugin,
  ConnectionCallbackExecutePlugin,
  ConnectionPromiseQueryPlugin,
  ConnectionPromiseExecutePlugin,
  PoolCallbackQueryPlugin,
  PoolCallbackExecutePlugin,
  PoolPromiseQueryPlugin,
  PoolPromiseExecutePlugin,
  V2ConnectionQueryPromisePlugin,
  V2ConnectionQueryPlugin,
  V2ConnectionQueryCallbackPlugin,
  V2PoolBaseQueryPlugin,
  PreparedStatementCallbackExecutePlugin,
]
