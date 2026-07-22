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

function createWrapQuery (options) {
  return function wrapQuery (query) {
    return function (sql) {
      if (!startCh.hasSubscribers) return query.apply(this, arguments)

      const ctx = { sql, conf: options }

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

function createWrapQueryCallback (options) {
  return function wrapQuery (query) {
    return function (sql) {
      if (!startCh.hasSubscribers) return query.apply(this, arguments)

      const cb = arguments[arguments.length - 1]
      const ctx = { sql, conf: options }
      const wrapper = (cb) => function (err) {
        if (err) {
          ctx.error = err
          errorCh.publish(ctx)
        }

        // Even with no real callback to run, finish must go through `runStores` rather than a bare
        // `publish`: the plugin's `finish` handler falls back to the ambient store when `ctx.currentStore`
        // is unset, and only `runStores` re-enters the bound store for that fallback to see the span.
        return typeof cb === 'function'
          ? finishCh.runStores(ctx, cb, this, ...arguments)
          : finishCh.runStores(ctx, () => {}, this)
      }

      if (typeof cb === 'function') {
        arguments[arguments.length - 1] = shimmer.wrapCallback(cb, wrapper)
      } else {
        arguments.length += 1
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

function wrapConnectionQueries (conn, options, wrapQuery) {
  if (!conn) return conn

  shimmer.wrap(conn, 'query', wrapQuery(options))
  shimmer.wrap(conn, 'execute', wrapQuery(options))
  shimmer.wrap(conn, 'batch', wrapQuery(options))

  // Pool instances don't have `prepare`; only connections do.
  if (conn.prepare) shimmer.wrap(conn, 'prepare', wrapPrepare(options))

  return conn
}

const wrappedStatements = new WeakSet()

// A prepared statement's `execute` (`lib/cmd/class/prepare-result-packet.js`) is the same dual-mode
// method regardless of whether it came from the promise or callback connection, so one wrapper
// handles both instead of needing separate createWrapQuery/createWrapQueryCallback variants.
function wrapStatementExecute (sql, options) {
  return function wrapExecute (execute) {
    return function (...args) {
      if (!startCh.hasSubscribers) return execute.apply(this, args)

      const ctx = { sql, conf: options }
      const cb = args.at(-1)

      if (typeof cb === 'function') {
        args[args.length - 1] = shimmer.wrapCallback(cb, cb => function (err) {
          if (err) {
            ctx.error = err
            errorCh.publish(ctx)
          }

          return finishCh.runStores(ctx, cb, this, ...arguments)
        })

        return startCh.runStores(ctx, execute, this, ...args)
      }

      return startCh.runStores(ctx, execute, this, ...args)
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

// `ConnectionCallback.prepare` delivers the statement through both its callback and its returned
// promise, so guard against wrapping the same statement's `execute` twice.
function wrapPreparedStatement (statement, sql, options) {
  if (!statement || wrappedStatements.has(statement)) return statement

  wrappedStatements.add(statement)
  shimmer.wrap(statement, 'execute', wrapStatementExecute(sql, options))

  return statement
}

function wrapPrepare (options) {
  return function wrapPrepareMethod (prepare) {
    return function (sql, ...rest) {
      const cb = rest.at(-1)

      if (typeof cb === 'function') {
        rest[rest.length - 1] = shimmer.wrapCallback(cb, cb => function (err, statement) {
          if (!err) wrapPreparedStatement(statement, sql, options)

          return cb.apply(this, arguments)
        })
      }

      return prepare.call(this, sql, ...rest).then(statement => wrapPreparedStatement(statement, sql, options))
    }
  }
}

// mariadb >=3.5 bundles lib/cmd/*.js, lib/pool.js and lib/connection*.js into a single
// minified dist/*.cjs file (esbuild), so the Command-class hooks above never load for it
// and the classes they target aren't reachable at all. The only thing left to hook is the
// createConnection/createPool factories the bundle exports, wrapping the query/execute/batch
// methods on the connection/pool instances they hand back instead of the Command classes.
function wrapBundledCreateConnection (wrapQuery) {
  return createConnection => function (...args) {
    const options = args[0]
    const result = createConnection.apply(this, args)

    return typeof result?.then === 'function'
      ? result.then(conn => wrapConnectionQueries(conn, options, wrapQuery))
      : wrapConnectionQueries(result, options, wrapQuery)
  }
}

function wrapBundledCreatePool (wrapQuery) {
  return createPool => function (...args) {
    const options = args[0]
    const pool = skipCh.runStores({}, createPool, this, ...args)

    wrapConnectionQueries(pool, options, wrapQuery)

    shimmer.wrap(pool, 'getConnection', getConnection => function (...args) {
      const ctx = {}

      connectionStartCh.publish(ctx)

      const cb = args.at(-1)

      if (typeof cb === 'function') {
        args[args.length - 1] = shimmer.wrapCallback(cb, cb => function (err, conn) {
          if (!err) wrapConnectionQueries(conn, options, wrapQuery)

          return connectionFinishCh.runStores(ctx, cb, this, ...arguments)
        })

        return skipCh.runStores({}, getConnection, this, ...args)
      }

      return skipCh.runStores({}, getConnection, this, ...args)
        .then(conn => connectionFinishCh.runStores(ctx, () => wrapConnectionQueries(conn, options, wrapQuery)))
    })

    return pool
  }
}

// The dist bundle's exports are esbuild-generated non-configurable getters (ESM-to-CJS
// interop), so `shimmer.wrap` receives the getter itself rather than the resolved function
// and expects a replacement getter back; `wrapReal` only ever sees the real exported function.
function wrapGetterExport (wrapReal) {
  return getter => function () {
    return wrapReal(getter.call(this))
  }
}

const name = 'mariadb'

addHook({ name, file: 'lib/cmd/query.js', versions: ['>=3 <3.5.0'] }, (Query) => {
  return wrapCommand(Query)
})

addHook({ name, file: 'lib/cmd/execute.js', versions: ['>=3 <3.5.0'] }, (Execute) => {
  return wrapCommand(Execute)
})

// mariadb 3.4.1 refactored the pool: getConnection switched from promises to
// callbacks and _createConnection was renamed to _createPoolConnection.
addHook({ name, file: 'lib/pool.js', versions: ['>=3.4.1 <3.5.0'] }, (Pool) => {
  shimmer.wrap(Pool.prototype, 'getConnection', wrapPoolGetConnectionMethod)
  shimmer.wrap(Pool.prototype, '_createPoolConnection', wrapPoolMethod)

  return Pool
})

// The CJS `dist/*.cjs` entrypoint exposes `createConnection`/`createPool` as non-configurable
// getters (see `wrapGetterExport` above), but the ESM `promise.js`/`callback.js` entrypoints
// (loaded via import-in-the-middle for an ESM `import`) expose them as plain values — on the
// namespace object directly, and again on its `default` export object, neither of which is a
// getter. `isIitm` tells the two shapes apart so the right wrapping strategy is used for each.
function wrapMariadbExports (wrapQuery) {
  return function (exports, moduleVersion, isIitm) {
    const wrapCreateConnection = wrapBundledCreateConnection(wrapQuery)
    const wrapCreatePool = wrapBundledCreatePool(wrapQuery)

    exports = shimmer.wrap(
      exports, 'createConnection', isIitm ? wrapCreateConnection : wrapGetterExport(wrapCreateConnection)
    )
    exports = shimmer.wrap(exports, 'createPool', isIitm ? wrapCreatePool : wrapGetterExport(wrapCreatePool))

    return exports
  }
}

const wrapMariadbPromiseExports = wrapMariadbExports(createWrapQuery)
const wrapMariadbCallbackExports = wrapMariadbExports(createWrapQueryCallback)

// 3.5.0 was never published and 3.5.1/3.5.2 dropped CommonJS support entirely (pure ESM,
// no `exports` map), so `require('mariadb')` throws ERR_REQUIRE_ESM for those regardless of
// this instrumentation; 3.5.3 is the first (and, floor-wise, only reachable) version with the
// dist bundle below.
//
// RITM reports a bare `require('mariadb')` as `moduleName: 'mariadb'` (its "is this the package's
// main entry" check succeeds for the bare specifier), but reports the resolved internal file
// (`mariadb/dist/promise.cjs`) for anything that reaches this same file through a different path.
// Register both shapes so either one is instrumented.
addHook({ name, versions: ['>=3.5.3'], node: '>=20' }, wrapMariadbPromiseExports)
addHook({ name, file: 'dist/promise.cjs', versions: ['>=3.5.3'], node: '>=20' }, wrapMariadbPromiseExports)

addHook({ name, file: 'dist/callback.cjs', versions: ['>=3.5.3'], node: '>=20' }, wrapMariadbCallbackExports)

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
