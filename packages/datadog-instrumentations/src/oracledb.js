'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const connectionAttributes = new WeakMap()
const poolAttributes = new WeakMap()

const startChannel = channel('apm:oracledb:query:start')
const errorChannel = channel('apm:oracledb:query:error')
const finishChannel = channel('apm:oracledb:query:finish')

function finish (ctx) {
  if (ctx.error) {
    errorChannel.publish(ctx.error)
  }
  finishChannel.publish(ctx)
}

addHook({ name: 'oracledb', versions: ['>=5'] }, oracledb => {
  shimmer.wrap(oracledb.Connection.prototype, 'execute', execute => {
    const ctx = {}
    return function wrappedExecute (dbQuery, ...args) {
      if (!startChannel.hasSubscribers) {
        return execute.apply(this, arguments)
      }

      if (arguments.length && typeof arguments[arguments.length - 1] === 'function') {
        const cb = arguments[arguments.length - 1]
        arguments[arguments.length - 1] = shimmer.wrapFunction(cb, cb => function wrappedCb (err, result) {
          if (err) {
            errorChannel.publish(err)
          }
          return finishChannel.runStores(ctx, () => {
            return cb.apply(this, arguments)
          })
        })
      }

      // The connAttrs are used to pass through the argument to the potential
      // serviceName method a user might have passed through as well as parsing
      // the connection string in v5.
      const connAttrs = connectionAttributes.get(this)

      const details = typeof this.hostName === 'string' ? this : this._impl

      let hostname
      let port
      let dbInstance

      if (details) {
        dbInstance = details.serviceName
        hostname = details.hostName ?? details.nscon?.ntAdapter?.hostName
        port = String(details.port ?? details.nscon?.ntAdapter?.port ?? '')
      }

      ctx.dbInstance = dbInstance
      ctx.port = port
      ctx.hostname = hostname
      ctx.query = dbQuery
      ctx.connAttrs = connAttrs

      return startChannel.runStores(ctx, () => {
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
      if (callback) {
        arguments[1] = shimmer.wrapFunction(callback, callback => (err, connection) => {
          if (connection) {
            connectionAttributes.set(connection, connAttrs)
          }
          callback(err, connection)
        })

        getConnection.apply(this, arguments)
      } else {
        return getConnection.apply(this, arguments).then((connection) => {
          connectionAttributes.set(connection, connAttrs)
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
            poolAttributes.set(pool, poolAttrs)
          }
          callback(err, pool)
        })

        createPool.apply(this, arguments)
      } else {
        return createPool.apply(this, arguments).then((pool) => {
          poolAttributes.set(pool, poolAttrs)
          return pool
        })
      }
    }
  })
  shimmer.wrap(oracledb.Pool.prototype, 'getConnection', getConnection => {
    return function wrappedGetConnection () {
      let callback
      if (typeof arguments[arguments.length - 1] === 'function') {
        callback = arguments[arguments.length - 1]
      }
      if (callback) {
        arguments[arguments.length - 1] = shimmer.wrapFunction(callback, callback => (err, connection) => {
          if (connection) {
            connectionAttributes.set(connection, poolAttributes.get(this))
          }
          callback(err, connection)
        })
        getConnection.apply(this, arguments)
      } else {
        return getConnection.apply(this, arguments).then((connection) => {
          connectionAttributes.set(connection, poolAttributes.get(this))
          return connection
        })
      }
    }
  })
  return oracledb
})
