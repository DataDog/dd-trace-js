'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

/** @typedef {{ length: number, [index: number]: unknown } & Iterable<unknown>} ArgumentsLike */

const connectionAttributes = new WeakMap()
const poolAttributes = new WeakMap()
const poolConnectionAttributes = new WeakMap()

const startChannel = channel('apm:oracledb:query:start')
const errorChannel = channel('apm:oracledb:query:error')
const finishChannel = channel('apm:oracledb:query:finish')
const poolAcquireStartChannel = channel('apm:oracledb:pool:acquire:start')
const poolAcquireErrorChannel = channel('apm:oracledb:pool:acquire:error')
const poolAcquireFinishChannel = channel('apm:oracledb:pool:acquire:finish')
const poolSessionStartChannel = channel('apm:oracledb:pool:session:start')
const poolSessionFinishChannel = channel('apm:oracledb:pool:session:finish')

/**
 * OracleDB only sets `Connection#user` for standalone connections, and Thick mode leaves the
 * schema fallback empty, so a heterogeneous pool's user comes from the acquisition options.
 *
 * @param {{ homogeneous: boolean, user?: string }} connectionAttrs
 * @param {unknown} options
 * @returns {string | undefined}
 */
function getAcquireUser (connectionAttrs, options) {
  if (connectionAttrs.homogeneous || typeof options !== 'object' || options === null) {
    return connectionAttrs.user
  }
  const { user, username } = /** @type {{ user?: string, username?: string }} */ (options)
  return user ?? username ?? connectionAttrs.user
}

function finish (ctx) {
  if (ctx.error) {
    errorChannel.publish(ctx)
  }
  finishChannel.publish(ctx)
}

/**
 * @param {Function} getConnection
 */
function wrapPoolGetConnection (getConnection) {
  /**
   * @param {...unknown} args
   */
  return function wrappedGetConnection (...args) {
    const pool = this
    const poolAttrs = poolAttributes.get(pool)
    const connectionAttrs = poolConnectionAttributes.get(pool)
    const callback = typeof args.at(-1) === 'function' ? args.at(-1) : undefined
    const acquireCtx = poolAcquireStartChannel.hasSubscribers
      ? { pool, connectionAttrs, poolAttrs, user: getAcquireUser(connectionAttrs, args[0]) }
      : undefined
    const sessionCtx = connectionAttrs.hasSessionCallback && poolSessionStartChannel.hasSubscribers
      ? { poolAttrs }
      : undefined

    if (callback) {
      args[args.length - 1] = shimmer.wrapFunction(callback, callback => function (error, connection) {
        if (connection) {
          connectionAttributes.set(connection, poolAttrs)
        }
        if (acquireCtx === undefined) {
          return callPoolCallback(sessionCtx, callback, this, arguments)
        }
        if (error) {
          acquireCtx.error = error
          poolAcquireErrorChannel.publish(acquireCtx)
        }
        return poolAcquireFinishChannel.runStores(
          acquireCtx,
          callPoolCallback,
          undefined,
          sessionCtx,
          callback,
          this,
          arguments
        )
      })

      return sessionCtx === undefined
        ? callPoolGetConnection(acquireCtx, getConnection, pool, args)
        : poolSessionStartChannel.runStores(
          sessionCtx,
          callPoolGetConnection,
          undefined,
          acquireCtx,
          getConnection,
          pool,
          args
        )
    }

    const promise = sessionCtx === undefined
      ? callPoolGetConnection(acquireCtx, getConnection, pool, args)
      : poolSessionStartChannel.runStores(
        sessionCtx,
        callPoolGetConnection,
        undefined,
        acquireCtx,
        getConnection,
        pool,
        args
      )

    if (acquireCtx === undefined) {
      return promise.then(connection => {
        connectionAttributes.set(connection, poolAttrs)
        return connection
      })
    }

    return promise.then(
      connection => {
        connectionAttributes.set(connection, poolAttrs)
        poolAcquireFinishChannel.publish(acquireCtx)
        return connection
      },
      error => {
        acquireCtx.error = error
        poolAcquireErrorChannel.publish(acquireCtx)
        poolAcquireFinishChannel.publish(acquireCtx)
        throw error
      }
    )
  }
}

/**
 * @param {object} pool
 * @param {{
 *   connectString?: string,
 *   connectionString?: string,
 *   homogeneous?: boolean,
 *   sessionCallback?: Function,
 *   user?: string,
 *   username?: string
 * }} poolAttrs
 */
function storePoolAttributes (pool, poolAttrs) {
  poolAttributes.set(pool, poolAttrs)
  poolConnectionAttributes.set(pool, {
    connectString: pool.connectString ?? poolAttrs.connectString ?? poolAttrs.connectionString,
    hasSessionCallback: typeof pool.sessionCallback === 'function',
    homogeneous: pool.homogeneous ?? poolAttrs.homogeneous ?? true,
    // OracleDB 5 accepts the `username` alias but only copies `user`/`userName` to `pool.user`.
    user: pool.user ?? poolAttrs.user ?? poolAttrs.username,
  })
  if (Object.hasOwn(pool, 'getConnection')) {
    shimmer.wrap(pool, 'getConnection', wrapPoolGetConnection)
  }
}

/**
 * @param {object | undefined} acquireCtx
 * @param {Function} getConnection
 * @param {object} pool
 * @param {unknown[]} args
 */
function callPoolGetConnection (acquireCtx, getConnection, pool, args) {
  return acquireCtx === undefined
    ? getConnection.apply(pool, args)
    : poolAcquireStartChannel.runStores(acquireCtx, getConnection, pool, ...args)
}

/**
 * @param {object | undefined} sessionCtx
 * @param {Function} callback
 * @param {unknown} thisArg
 * @param {ArgumentsLike} args
 */
function callPoolCallback (sessionCtx, callback, thisArg, args) {
  return sessionCtx === undefined
    ? callback.apply(thisArg, args)
    : poolSessionFinishChannel.runStores(sessionCtx, callback, thisArg, ...args)
}

addHook({ name: 'oracledb', versions: ['>=5'], file: 'lib/oracledb.js' }, oracledb => {
  shimmer.wrap(oracledb.Connection.prototype, 'execute', execute => {
    return function wrappedExecute (dbQuery) {
      if (!startChannel.hasSubscribers) {
        return execute.apply(this, arguments)
      }

      if (arguments.length && typeof arguments[arguments.length - 1] === 'function') {
        const cb = arguments[arguments.length - 1]
        arguments[arguments.length - 1] = shimmer.wrapFunction(cb, cb => function wrappedCb (err, result) {
          if (err) {
            ctx.error = err
            errorChannel.publish(ctx)
          }
          return finishChannel.runStores(ctx, () => {
            return cb.apply(this, arguments)
          })
        })
      }

      let hostname
      let port
      let dbInstance

      try {
        if (this.thin) {
          const details = this._impl ?? this
          // Prefer public getters when available (v6), fallback to nscon in v5.
          dbInstance = this.serviceName ?? details.serviceName
          hostname = this.hostName ?? details.nscon?.ntAdapter?.hostName
          const p = this.port ?? details.nscon?.ntAdapter?.port
          if (p != null) port = String(p)
        } else {
          // Avoid host/port getters in thick mode, as they may throw.
          dbInstance = this.serviceName
        }
      } catch {}

      // The connAttrs are used to pass through the argument to the potential
      // serviceName method a user might have passed through as well as parsing
      // the connection string in v5 as well as in thick mode.
      const connAttrs = connectionAttributes.get(this)

      const ctx = {
        dbInstance,
        port,
        hostname,
        query: dbQuery,
        connAttrs,
      }

      return startChannel.runStores(ctx, () => {
        // bindStart is skipped when tracing is suppressed (legacy store is `noop`),
        // leaving ctx.injected unset — do not overwrite the caller's SQL argument.
        if (ctx.injected !== undefined) {
          arguments[0] = ctx.injected
        }
        try {
          let result = execute.apply(this, arguments)

          if (typeof result?.then === 'function') {
            result = result.then(
              x => {
                finish(ctx)
                return x
              },
              e => {
                ctx.error = e
                finish(ctx)
                throw e
              }
            )
          }

          return result
        } catch (err) {
          ctx.error = err
          finish(ctx)
          throw err
        }
      })
    }
  })
  shimmer.wrap(oracledb, 'getConnection', getConnection => {
    return function wrappedGetConnection (connAttrs, callback) {
      if (typeof connAttrs === 'function') {
        callback = connAttrs
        connAttrs = undefined
      }
      if (callback) {
        arguments[arguments.length - 1] = shimmer.wrapFunction(callback, callback => (err, connection) => {
          if (connection && !connectionAttributes.has(connection)) {
            connectionAttributes.set(connection, connAttrs)
          }
          callback(err, connection)
        })

        getConnection.apply(this, arguments)
      } else {
        return getConnection.apply(this, arguments).then((connection) => {
          if (!connectionAttributes.has(connection)) {
            connectionAttributes.set(connection, connAttrs)
          }
          return connection
        })
      }
    }
  })
  shimmer.wrap(oracledb, 'createPool', createPool => {
    return function wrappedCreatePool (poolAttrs, callback) {
      if (callback) {
        arguments[1] = shimmer.wrapFunction(callback, callback => (err, pool) => {
          if (pool) {
            storePoolAttributes(pool, poolAttrs)
          }
          callback(err, pool)
        })

        createPool.apply(this, arguments)
      } else {
        return createPool.apply(this, arguments).then((pool) => {
          storePoolAttributes(pool, poolAttrs)
          return pool
        })
      }
    }
  })
  // OracleDB callbackifies this method at module setup, and connection metadata must be attached
  // before completion is published. Orchestrion cannot replace both completion paths in that order.
  if (typeof oracledb.Pool.prototype.getConnection === 'function') {
    shimmer.wrap(oracledb.Pool.prototype, 'getConnection', wrapPoolGetConnection)
  }
  return oracledb
})
