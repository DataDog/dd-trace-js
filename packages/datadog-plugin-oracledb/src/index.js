'use strict'

const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

const connectionAttributes = new WeakMap()
const poolAttributes = new WeakMap()

function createWrapExecute (tracer, config) {
  return function wrapExecute (execute) {
    return function executeWithTrace (dbQuery, ...args) {
      const connAttrs = connectionAttributes.get(this)
      const service = getServiceName(tracer, config, connAttrs)
      const connectStringObj = new URL('http://' + connAttrs.connectString)
      const tags = {
        'span.kind': 'client',
        'span.type': 'sql',
        'sql.query': dbQuery,
        'db.instance': connectStringObj.pathname.substring(1),
        'db.hostname': connectStringObj.hostname,
        'db.user': config.user,
        'db.port': connectStringObj.port,
        'resource.name': dbQuery,
        'service.name': service
      }

      return tracer.wrap('oracle.query', { tags }, function (...args) {
        const span = tracer.scope().active()

        analyticsSampler.sample(span, config.measured)

        return execute.apply(this, args)
      }).apply(this, arguments)
    }
  }
}

function createWrapGetConnection (tracer, config) {
  return function wrapGetConnection (getConnection) {
    return function getConnectionWithTrace (connAttrs, callback) {
      if (callback) {
        arguments[1] = (err, connection) => {
          if (connection) {
            connectionAttributes.set(connection, connAttrs)
          }
          callback(err, connection)
        }

        getConnection.apply(this, arguments)
      } else {
        return getConnection.apply(this, arguments).then((connection) => {
          connectionAttributes.set(connection, connAttrs)
          return connection
        })
      }
    }
  }
}

function createWrapCreatePool (tracer, config) {
  return function wrapCreatePool (createPool) {
    return function createPoolWithTrace (poolAttrs, callback) {
      if (callback) {
        arguments[1] = (err, pool) => {
          if (pool) {
            poolAttributes.set(pool, poolAttrs)
          }
          callback(err, pool)
        }

        createPool.apply(this, arguments)
      } else {
        return createPool.apply(this, arguments).then((pool) => {
          poolAttributes.set(pool, poolAttrs)
          return pool
        })
      }
    }
  }
}

function createWrapPoolGetConnection (tracer, config) {
  return function wrapPoolGetConnection (getConnection) {
    return function poolGetConnectionWithTrace () {
      let callback
      if (typeof arguments[arguments.length - 1] === 'function') {
        callback = arguments[arguments.length - 1]
      }
      if (callback) {
        arguments[arguments.length - 1] = (err, connection) => {
          if (connection) {
            connectionAttributes.set(connection, poolAttributes.get(this))
          }
          callback(err, connection)
        }
        getConnection.apply(this, arguments)
      } else {
        return getConnection.apply(this, arguments).then((connection) => {
          connectionAttributes.set(connection, poolAttributes.get(this))
          return connection
        })
      }
    }
  }
}

function getServiceName (tracer, config, connAttrs) {
  if (typeof config.service === 'function') {
    return config.service(connAttrs)
  } else if (config.service) {
    return config.service
  } else {
    return `${tracer._service}-oracle`
  }
}

module.exports = {
  name: 'oracledb',
  versions: ['5'],
  patch (oracledb, tracer, config) {
    this.wrap(oracledb.Connection.prototype, 'execute', createWrapExecute(tracer, config))
    this.wrap(oracledb, 'getConnection', createWrapGetConnection(tracer, config))
    this.wrap(oracledb, 'createPool', createWrapCreatePool(tracer, config))
    this.wrap(oracledb.Pool.prototype, 'getConnection', createWrapPoolGetConnection(tracer, config))
  },
  unpatch (oracledb) {
    this.unwrap(oracledb.Connection.prototype, 'execute')
    this.unwrap(oracledb, 'getConnection')
    this.unwrap(oracledb, 'createPool')
    this.unwrap(oracledb.Pool.prototype, 'getConnection')
  }
}
