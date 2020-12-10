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
    return async function getConnectionWithTrace (connAttrs) {
      const conn = await getConnection.call(this, connAttrs)
      conn._dd_connAttrs = connAttrs
      return conn
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
  versions: ['*'],
  patch (oracledb, tracer, config) {
    this.wrap(oracledb.Connection.prototype, 'execute', createWrapExecute(tracer, config))
    this.wrap(oracledb, 'getConnection', createWrapGetConnection(tracer, config))
  },
  unpatch (oracledb) {
    this.unwrap(oracledb.Connection.prototype, 'execute')
    this.unwrap(oracledb, 'getConnection')
  }
}
