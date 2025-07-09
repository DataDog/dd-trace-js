'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const connectionAttributes = new WeakMap()
const poolAttributes = new WeakMap()

const startChannel = channel('apm:oracledb:query:start')
const errorChannel = channel('apm:oracledb:query:error')
const finishChannel = channel('apm:oracledb:query:finish')

function finish (err) {
  if (err) {
    errorChannel.publish(err)
  }
  finishChannel.publish()
}

addHook({ name: 'oracledb', versions: ['>=5'] }, oracledb => {
  shimmer.wrap(oracledb.Connection.prototype, 'execute', execute => {
    return function wrappedExecute (dbQuery, ...args) {
      if (!startChannel.hasSubscribers) {
        return execute.apply(this, arguments)
      }

      if (arguments.length && typeof arguments[arguments.length - 1] === 'function') {
        const cb = arguments[arguments.length - 1]
        const outerAr = new AsyncResource('apm:oracledb:outer-scope')
        arguments[arguments.length - 1] = shimmer.wrapFunction(cb, cb => function wrappedCb (err, result) {
          finish(err)
          return outerAr.runInAsyncScope(() => cb.apply(this, arguments))
        })
      }

      return new AsyncResource('apm:oracledb:inner-scope').runInAsyncScope(() => {
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

        startChannel.publish({
          query: dbQuery,
          connAttrs,
          dbInstance,
          port,
          hostname,
        })
        try {
          let result = execute.apply(this, arguments)

          if (typeof result?.then === 'function') {
            result = result.then(
              x => {
                finish()
                return x
              },
              e => {
                finish(e)
                throw e
              }
            )
          }

          return result
        } catch (err) {
          errorChannel.publish(err)
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
