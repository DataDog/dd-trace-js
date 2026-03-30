'use strict'

const { storage } = require('../../datadog-core')
const Plugin = require('../../dd-trace/src/plugins/plugin')

const DD_CONF = '__ddConf'

/**
 * Extracts connection-relevant config from the raw user options.
 *
 * @param {object} opts - Raw options passed to createConnection or createPool
 * @returns {{ host?: string, user?: string, database?: string, port?: number }}
 */
function extractConf (opts) {
  if (!opts || typeof opts !== 'object') return {}
  return {
    host: opts.host,
    user: opts.user,
    database: opts.database,
    port: opts.port,
  }
}

/**
 * Base class for connection/pool factory tracking.
 *
 * Listens on the createConnection / createPool orchestrion channels and
 * stashes the raw user-supplied connection options onto the returned
 * instance so that query plugins can read them as `ctx.self.__ddConf`.
 */
class MariadbConnectionTrackingPlugin extends Plugin {
  static id = 'mariadb'

  constructor () {
    super(...arguments)

    const prefix = this.constructor.prefix

    // Clear context during createConnection/createPool so that pool-internal
    // TCP connections (e.g. from minimumIdle) don't become children of the
    // user's active span.
    this.addBind(`${prefix}:start`, () => null)

    this.addSub(`${prefix}:end`, ctx => {
      this.storeConf(ctx)
    })

    this.addSub(`${prefix}:asyncEnd`, ctx => {
      this.storeConf(ctx)
    })
  }

  /**
   * Store connection config on the returned instance.
   *
   * @param {object} ctx - Orchestrion channel context
   */
  storeConf (ctx) {
    const opts = ctx.arguments?.[0]
    const target = ctx.result || ctx.self

    if (target && opts) {
      target[DD_CONF] = extractConf(opts)
    }
  }

  configure (config) {
    return super.configure(config)
  }
}

/**
 * Handles both callback.js and promise.js createConnection calls.
 * Both share the same orchestrion channelName 'createConnection'.
 * callback.js is Sync (fires end), promise.js is Async (fires asyncEnd).
 */
class CreateConnectionPlugin extends MariadbConnectionTrackingPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:createConnection'
}

/**
 * Handles both callback.js and promise.js createPool calls.
 * Both share the same orchestrion channelName 'createPool'.
 * Both are Sync (fire end).
 */
class CreatePoolPlugin extends MariadbConnectionTrackingPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:createPool'
}

/**
 * Handles Pool.getConnection (v>=3.4.1).
 * Propagates config from the pool to the returned connection, and
 * captures parent store to restore context after pool-internal operations.
 */
class PoolGetConnectionPlugin extends Plugin {
  static id = 'mariadb'

  constructor () {
    super(...arguments)

    const prefix = 'tracing:orchestrion:mariadb:Pool_getConnection'

    // Save the user's context before start clears it, and return null to clear
    // context so pool-internal TCP connections don't become children of the user span.
    this.addBind(`${prefix}:start`, ctx => {
      ctx.parentStore = storage('legacy').getStore()
      return null
    })

    // asyncStart uses runStores (unlike asyncEnd which uses publish), so addBind works here.
    // ctx.result is the connection passed to the callback by the pool.
    this.addBind(`${prefix}:asyncStart`, ctx => {
      const conn = ctx.result

      // Propagate pool config to the returned connection.
      // ctx.self is the internal Pool instance which stores PoolOptions on `opts`.
      // PoolOptions.connOptions is a ConnOptions with host, user, database, port.
      if (conn) {
        const poolSelf = ctx.self
        if (poolSelf?.[DD_CONF]) {
          conn[DD_CONF] = poolSelf[DD_CONF]
        } else if (poolSelf?.opts?.connOptions) {
          conn[DD_CONF] = extractConf(poolSelf.opts.connOptions)
        }
      }

      return ctx.parentStore
    })
  }

  configure (config) {
    return super.configure(config)
  }
}

/**
 * Handles v<3 Connection constructor wrapping.
 * Stashes config on the new connection instance via ctx.self.
 */
class V2ConnectionPlugin extends MariadbConnectionTrackingPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:v2Connection'
}

/**
 * Handles v<3 PoolBase constructor wrapping.
 * Stashes pool connOptions on the new pool instance via ctx.self.
 * Pool options nest the connection config under `connOptions`.
 */
class V2PoolBasePlugin extends MariadbConnectionTrackingPlugin {
  static id = 'mariadb'
  static prefix = 'tracing:orchestrion:mariadb:v2PoolBase'

  storeConf (ctx) {
    const opts = ctx.arguments?.[0]
    const target = ctx.self

    if (target && opts) {
      target[DD_CONF] = extractConf(opts.connOptions || opts)
    }
  }
}

/**
 * Handles v<3 PoolBase.getConnection calls.
 * Clears context during execution so pool-internal TCP connections don't
 * become children of the user's span, and propagates pool conf to the
 * returned connection.
 */
class V2PoolBaseGetConnectionPlugin extends Plugin {
  static id = 'mariadb'

  constructor () {
    super(...arguments)

    const prefix = 'tracing:orchestrion:mariadb:v2PoolBase_getConnection'

    this.addBind(`${prefix}:start`, ctx => {
      ctx.parentStore = storage('legacy').getStore()
      return null
    })

    this.addBind(`${prefix}:asyncStart`, ctx => {
      const conn = ctx.result
      if (conn) {
        const poolSelf = ctx.self
        if (poolSelf?.[DD_CONF]) {
          conn[DD_CONF] = poolSelf[DD_CONF]
        }
      }
      return ctx.parentStore
    })
  }

  configure (config) {
    return super.configure(config)
  }
}

module.exports = [
  CreateConnectionPlugin,
  CreatePoolPlugin,
  PoolGetConnectionPlugin,
  V2ConnectionPlugin,
  V2PoolBasePlugin,
  V2PoolBaseGetConnectionPlugin,
]
