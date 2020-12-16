function createWrapExecute (tracer, config) {
  return function wrapExecute (execute) {
    return function executeWithTrace (dbQuery, ...args) {
      const connAttrs = this._dd_connAttrs
      const service = getServiceName(tracer, config, connAttrs)
      const connectStringObj = new URL('http://' + connAttrs.connectString)
      return tracer.trace('exec.query', {
        tags: {
          'span.kind': 'client',
          'sql.query': dbQuery,
          'db.instance': connectStringObj.pathname.substring(1),
          'db.hostname': connectStringObj.hostname,
          'db.user': config.user,
          'db.port': connectStringObj.port,
          'resource.name': dbQuery,
          'service.name': service
        }
      }, (span) => {
        return execute.call(this, dbQuery, ...args)
      })
    }
  }
}

function createWrapGetConnection (tracer, config) {
  return function wrapGetConnection (getConnection) {
    return function getConnectionWithTrace (connAttrs, callback) {
      if (callback) {
        getConnection.call(this, connAttrs, (err, connection) => {
          if (connection) {
            connection._dd_connAttrs = connAttrs
          }
          callback(err, connection)
        })
      } else {
        return getConnection.call(this, connAttrs).then((connection) => {
          connection._dd_connAttrs = connAttrs
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
        createPool.call(this, poolAttrs, (err, pool) => {
          if (pool) {
            pool._dd_poolAttrs = poolAttrs
          }
          callback(err, pool)
        })
      } else {
        return createPool.call(this, poolAttrs).then((pool) => {
          pool._dd_poolAttrs = poolAttrs
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
            connection._dd_connAttrs = this._dd_poolAttrs
          }
          callback(err, connection)
        }
        getConnection.apply(this, arguments)
      } else {
        return getConnection.apply(this, arguments).then((connection) => {
          connection._dd_connAttrs = this._dd_poolAttrs
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
    return `${tracer._service}-oracledb`
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
