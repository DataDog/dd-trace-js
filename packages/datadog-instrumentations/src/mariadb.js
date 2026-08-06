'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

const commandAddCh = channel('apm:mariadb:command:add')
const connectionStartCh = channel('apm:mariadb:connection:start')
const connectionFinishCh = channel('apm:mariadb:connection:finish')
const startCh = channel('apm:mariadb:query:start')
const finishCh = channel('apm:mariadb:query:finish')
const errorCh = channel('apm:mariadb:query:error')
const skipCh = channel('apm:mariadb:pool:skip')

const wrappedClients = new WeakSet()
const wrappedConnections = new WeakSet()
const noop = () => {}

function wrapCommandStart (start, ctx) {
  return shimmer.wrapFunction(start, start => function (...args) {
    if (!startCh.hasSubscribers) return start.apply(this, args)

    const { reject, resolve } = this
    shimmer.wrap(this, 'resolve', function wrapResolve () {
      return function (...args) {
        return finishCh.runStores(ctx, resolve, this, ...args)
      }
    })

    shimmer.wrap(this, 'reject', function wrapReject () {
      return function (error) {
        ctx.error = error

        errorCh.publish(ctx)

        return finishCh.runStores(ctx, reject, this, ...arguments)
      }
    })

    return startCh.runStores(ctx, start, this, ...args)
  })
}

function wrapCommand (Command) {
  return class extends Command {
    constructor (...args) {
      super(...args)

      if (!this.start) return

      const ctx = { sql: this.sql, conf: this.opts }

      commandAddCh.publish(ctx)

      this.start = wrapCommandStart(this.start, ctx)
    }
  }
}

function createWrapQuery (options, preparedSql) {
  return function wrapQuery (query) {
    return function (sql) {
      if (!startCh.hasSubscribers) return query.apply(this, arguments)

      const ctx = { sql: preparedSql ?? sql, conf: options }

      return startCh.runStores(ctx, query, this, ...arguments)
        .then(result => {
          ctx.result = result
          finishCh.publish(ctx)
          return result
        }, error => {
          ctx.error = error
          errorCh.publish(ctx)
          finishCh.publish(ctx)
          throw error
        })
    }
  }
}

function createWrapQueryCallback (options, preparedSql) {
  return function wrapQuery (query) {
    return function (sql) {
      if (!startCh.hasSubscribers) return query.apply(this, arguments)

      const cb = arguments[arguments.length - 1]
      const ctx = { sql: preparedSql ?? sql, conf: options }
      const wrapper = (cb) => function (err) {
        if (err) {
          ctx.error = err
          errorCh.publish(ctx)
        }

        return typeof cb === 'function'
          ? finishCh.runStores(ctx, cb, this, ...arguments)
          : finishCh.runStores(ctx, noop, this)
      }

      if (typeof cb === 'function') {
        arguments[arguments.length - 1] = shimmer.wrapCallback(cb, wrapper)
      } else {
        arguments.length = Math.max(arguments.length + 1, query.length)
        arguments[arguments.length - 1] = wrapper()
      }

      return startCh.runStores(ctx, query, this, ...arguments)
    }
  }
}

function wrapConnection (promiseMethod, Connection) {
  return function (options) {
    Connection.apply(this, arguments)

    shimmer.wrap(this, promiseMethod, createWrapQuery(options))
    shimmer.wrap(this, '_queryCallback', createWrapQueryCallback(options))
  }
}

function wrapPoolBase (PoolBase) {
  return function (options, processTask, createConnectionPool, pingPromise) {
    arguments[1] = wrapPoolMethod(processTask)
    arguments[2] = wrapPoolMethod(createConnectionPool)

    PoolBase.apply(this, arguments)

    shimmer.wrap(this, 'query', createWrapQuery(options.connOptions))
  }
}

// It's not possible to prevent connection pools from leaking across queries,
// so instead we just skip instrumentation completely to avoid memory leaks
// and/or orphan spans.
function wrapPoolMethod (createConnection) {
  return function (...args) {
    return skipCh.runStores({}, createConnection, this, ...args)
  }
}

function wrapPoolGetConnectionMethod (getConnection) {
  return function wrappedGetConnection (...args) {
    const cb = args.at(-1)
    if (typeof cb !== 'function') return getConnection.apply(this, args)

    const ctx = {}

    args[args.length - 1] = function (...args) {
      return connectionFinishCh.runStores(ctx, cb, this, ...args)
    }

    connectionStartCh.publish(ctx)

    return getConnection.apply(this, args)
  }
}

/**
 * Wraps the public query methods exposed by MariaDB's bundled CommonJS clients.
 *
 * @param {object} client
 * @param {(query: Function) => Function} wrapper
 * @returns {object}
 */
function wrapClient (client, wrapper) {
  if (wrappedClients.has(client)) return client

  wrappedClients.add(client)
  shimmer.wrap(client, 'query', wrapper)
  shimmer.wrap(client, 'execute', wrapper)

  return client
}

/**
 * Wraps a promise connection and the prepared statements it creates.
 *
 * @param {object} connection
 * @param {object} options
 * @returns {object}
 */
function wrapPromiseConnection (connection, options) {
  wrapClient(connection, createWrapQuery(options))
  if (wrappedConnections.has(connection)) return connection

  wrappedConnections.add(connection)
  shimmer.wrap(connection, 'prepare', createWrapPromisePrepare(options))

  return connection
}

/**
 * Wraps a callback connection and the prepared statements it creates.
 *
 * @param {object} connection
 * @param {object} options
 * @returns {object}
 */
function wrapCallbackConnection (connection, options) {
  wrapClient(connection, createWrapQueryCallback(options))
  if (wrappedConnections.has(connection)) return connection

  wrappedConnections.add(connection)
  shimmer.wrap(connection, 'prepare', createWrapCallbackPrepare(options))

  return connection
}

/**
 * Wraps prepared statements created by a promise connection.
 *
 * @param {object} options
 * @returns {(prepare: Function) => Function}
 */
function createWrapPromisePrepare (options) {
  return function wrapPrepare (prepare) {
    return function (sql) {
      return prepare.apply(this, arguments).then(statement => {
        shimmer.wrap(statement, 'execute', createWrapQuery(options, sql))
        return statement
      })
    }
  }
}

/**
 * Wraps prepared statements created by a callback connection.
 *
 * @param {object} options
 * @returns {(prepare: Function) => Function}
 */
function createWrapCallbackPrepare (options) {
  return function wrapPrepare (prepare) {
    return function (sql) {
      const cb = arguments[arguments.length - 1]
      if (typeof cb !== 'function') return prepare.apply(this, arguments)

      arguments[arguments.length - 1] = function () {
        const statement = arguments[1]
        if (statement) shimmer.wrap(statement, 'execute', createWrapQueryCallback(options, sql))
        return cb.apply(this, arguments)
      }

      return prepare.apply(this, arguments)
    }
  }
}

/**
 * Runs pool internals in the instrumentation skip store while tracing the public query.
 *
 * @param {object} options
 * @param {(options: object) => (query: Function) => Function} createWrapper
 * @returns {(query: Function) => Function}
 */
function createWrapPoolQuery (options, createWrapper) {
  return function wrapPoolQuery (query) {
    return createWrapper(options)(function () {
      return skipCh.runStores({}, query, this, ...arguments)
    })
  }
}

/**
 * Restores the caller's context and instruments a pooled promise connection.
 *
 * @param {object} ctx
 * @param {object} connection
 * @param {object} options
 * @returns {object}
 */
function finishPromiseGetConnection (ctx, connection, options) {
  return connectionFinishCh.runStores(ctx, wrapPromiseConnection, undefined, connection, options)
}

/**
 * Restores the caller's context when acquiring a promise connection fails.
 *
 * @param {object} ctx
 * @param {Error} error
 * @throws {Error}
 */
function finishPromiseGetConnectionError (ctx, error) {
  return connectionFinishCh.runStores(ctx, () => { throw error })
}

/**
 * Wraps getConnection on MariaDB's bundled CommonJS promise pool.
 *
 * @param {object} options
 * @returns {(getConnection: Function) => Function}
 */
function createWrapPromiseGetConnection (options) {
  return function wrapGetConnection (getConnection) {
    return function () {
      const ctx = {}

      connectionStartCh.publish(ctx)

      return skipCh.runStores({}, getConnection, this, ...arguments).then(
        connection => finishPromiseGetConnection(ctx, connection, options),
        error => finishPromiseGetConnectionError(ctx, error)
      )
    }
  }
}

/**
 * Wraps getConnection on MariaDB's bundled CommonJS callback pool.
 *
 * @param {object} options
 * @returns {(getConnection: Function) => Function}
 */
function createWrapCallbackGetConnection (options) {
  return function wrapGetConnection (getConnection) {
    return function () {
      const cb = arguments[arguments.length - 1]
      if (typeof cb !== 'function') return getConnection.apply(this, arguments)

      const ctx = {}
      arguments[arguments.length - 1] = function () {
        const connection = arguments[1]
        if (connection) wrapCallbackConnection(connection, options)
        return connectionFinishCh.runStores(ctx, cb, this, ...arguments)
      }

      connectionStartCh.publish(ctx)

      return skipCh.runStores({}, getConnection, this, ...arguments)
    }
  }
}

/**
 * Instruments the promise API exported by MariaDB's bundled CommonJS entry.
 *
 * @param {object} mariadb
 * @param {string} _version
 * @param {boolean} isIitm
 * @returns {object}
 */
function wrapPromiseBundle (mariadb, _version, isIitm) {
  if (isIitm) return mariadb

  mariadb = { ...mariadb, default: { ...mariadb.default } }

  shimmer.wrap(mariadb, 'createConnection', createConnection => function (options) {
    return createConnection.apply(this, arguments).then(connection => {
      return wrapPromiseConnection(connection, options)
    })
  })

  shimmer.wrap(mariadb, 'createPool', createPool => function (options) {
    const pool = skipCh.runStores({}, createPool, this, ...arguments)
    wrapClient(pool, createWrapPoolQuery(options, createWrapQuery))
    shimmer.wrap(pool, 'getConnection', createWrapPromiseGetConnection(options))
    return pool
  })

  mariadb.default.createConnection = mariadb.createConnection
  mariadb.default.createPool = mariadb.createPool

  return mariadb
}

/**
 * Instruments the callback API exported by MariaDB's bundled CommonJS entry.
 *
 * @param {object} mariadb
 * @returns {object}
 */
function wrapCallbackBundle (mariadb) {
  mariadb = { ...mariadb, default: { ...mariadb.default } }

  shimmer.wrap(mariadb, 'createConnection', createConnection => function (options) {
    return wrapCallbackConnection(createConnection.apply(this, arguments), options)
  })

  shimmer.wrap(mariadb, 'createPool', createPool => function (options) {
    const pool = skipCh.runStores({}, createPool, this, ...arguments)
    wrapClient(pool, createWrapPoolQuery(options, createWrapQueryCallback))
    shimmer.wrap(pool, 'getConnection', createWrapCallbackGetConnection(options))
    return pool
  })

  mariadb.default.createConnection = mariadb.createConnection
  mariadb.default.createPool = mariadb.createPool

  return mariadb
}

/**
 * Instruments the MariaDB pool implementation used by 3.4.1 and newer.
 *
 * @param {Function} Pool
 * @returns {Function}
 */
function wrapPool (Pool) {
  shimmer.wrap(Pool.prototype, 'getConnection', wrapPoolGetConnectionMethod)
  shimmer.wrap(Pool.prototype, '_createPoolConnection', wrapPoolMethod)

  return Pool
}

const name = 'mariadb'

addHook({ name, file: 'lib/cmd/query.js', versions: ['>=3 <3.5.1'] }, wrapCommand)
addHook({ name, file: 'lib/cmd/query.js', versions: ['>=3.5.1'], patchDefault: true }, wrapCommand)

addHook({ name, file: 'lib/cmd/execute.js', versions: ['>=3 <3.5.1'] }, wrapCommand)
addHook({ name, file: 'lib/cmd/execute.js', versions: ['>=3.5.1'], patchDefault: true }, wrapCommand)

// mariadb 3.4.1 refactored the pool: getConnection switched from promises to
// callbacks and _createConnection was renamed to _createPoolConnection.
addHook({ name, file: 'lib/pool.js', versions: ['>=3.4.1 <3.5.1'] }, wrapPool)
addHook({ name, file: 'lib/pool.js', versions: ['>=3.5.1'], patchDefault: true }, wrapPool)

addHook({ name, file: 'lib/pool.js', versions: ['>=3 <3.4.1'] }, (Pool) => {
  shimmer.wrap(Pool.prototype, '_createConnection', wrapPoolMethod)

  return Pool
})

addHook({ name, file: 'lib/connection.js', versions: ['>=2.5.2 <3'] }, (Connection) => {
  return shimmer.wrapFunction(Connection, wrapConnection.bind(null, '_queryPromise'))
})

addHook({ name, file: 'lib/connection.js', versions: ['>=2.0.4 <=2.5.1'] }, (Connection) => {
  return shimmer.wrapFunction(Connection, wrapConnection.bind(null, 'query'))
})

addHook({ name, file: 'lib/pool-base.js', versions: ['>=2.0.4 <3'] }, (PoolBase) => {
  return shimmer.wrapFunction(PoolBase, wrapPoolBase)
})

// MariaDB 3.5.3 added conditional CommonJS exports built as single-file bundles. Since their internal classes do not
// pass through the module loader, instrument the public factories in those bundles instead.
addHook({ name, versions: ['>=3.5.3'] }, wrapPromiseBundle)
addHook({ name, file: 'dist/callback.cjs', versions: ['>=3.5.3'] }, wrapCallbackBundle)
