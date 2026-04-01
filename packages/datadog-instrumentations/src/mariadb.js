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

function wrapCommandStart(start, ctx) {
  return shimmer.wrapFunction(start, start => function () {
    if (!startCh.hasSubscribers) return start.apply(this, arguments)

    const { reject, resolve } = this
    shimmer.wrap(this, 'resolve', function wrapResolve() {
      return function () {
        return finishCh.runStores(ctx, resolve, this, ...arguments)
      }
    })

    shimmer.wrap(this, 'reject', function wrapReject() {
      return function (error) {
        ctx.error = error

        errorCh.publish(ctx)

        return finishCh.runStores(ctx, reject, this, ...arguments)
      }
    })

    return startCh.runStores(ctx, start, this, ...arguments)
  })
}

function wrapCommand(Command) {
  if (!Command.prototype.start) return Command

  shimmer.wrap(Command.prototype, 'start', function (start) {
    return function wrappedStart () {
      if (!startCh.hasSubscribers) return start.apply(this, arguments)

      const ctx = { sql: this.sql, conf: this.opts }

      commandAddCh.publish(ctx)

      return wrapCommandStart(start, ctx).apply(this, arguments)
    }
  })

  return Command
}

function createWrapQuery(options) {
  return function wrapQuery(query) {
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

function createWrapQueryCallback(options) {
  return function wrapQuery(query) {
    return function (sql) {
      if (!startCh.hasSubscribers) return query.apply(this, arguments)

      const cb = arguments[arguments.length - 1]
      const ctx = { sql, conf: options }
      const wrapper = (cb) => function (err) {
        if (err) {
          ctx.error = err
          errorCh.publish(ctx)
        }

        return typeof cb === 'function'
          ? finishCh.runStores(ctx, cb, this, ...arguments)
          : finishCh.publish(ctx)
      }

      if (typeof cb === 'function') {
        arguments[arguments.length - 1] = shimmer.wrapFunction(cb, wrapper)
      } else {
        arguments.length += 1
        arguments[arguments.length - 1] = wrapper()
      }

      return startCh.runStores(ctx, query, this, ...arguments)
    }
  }
}

function wrapConnection(promiseMethod, Connection) {
  return function (options) {
    Connection.apply(this, arguments)

    shimmer.wrap(this, promiseMethod, createWrapQuery(options))
    shimmer.wrap(this, '_queryCallback', createWrapQueryCallback(options))
  }
}

function wrapPoolBase(PoolBase) {
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
function wrapPoolMethod(createConnection) {
  return function () {
    return skipCh.runStores({}, createConnection, this, ...arguments)
  }
}

function wrapPoolGetConnectionMethod(getConnection) {
  return function wrappedGetConnection() {
    const cb = arguments[arguments.length - 1]
    if (typeof cb !== 'function') return getConnection.apply(this, arguments)

    const ctx = {}

    arguments[arguments.length - 1] = function () {
      return connectionFinishCh.runStores(ctx, cb, this, ...arguments)
    }

    connectionStartCh.publish(ctx)

    return getConnection.apply(this, arguments)
  }
}

const name = 'mariadb'

addHook({ name, file: 'lib/cmd/query.js', versions: ['>=3'], patchDefault: true }, (Query) => {
  return wrapCommand(Query)
})

addHook({ name, file: 'lib/cmd/execute.js', versions: ['>=3'], patchDefault: true }, (Execute) => {
  return wrapCommand(Execute)
})

// in 3.4.1 getConnection method start to use callbacks instead of promises
addHook({ name, file: 'lib/pool.js', versions: ['>=3.4.1'], patchDefault: true }, (Pool) => {
  shimmer.wrap(Pool.prototype, 'getConnection', wrapPoolGetConnectionMethod)

  return Pool
})

// _createConnection was renamed to _createPoolConnection in 3.5.1 alongside the ESM migration
addHook({ name, file: 'lib/pool.js', versions: ['>=3 <3.5.1'] }, (Pool) => {
  shimmer.wrap(Pool.prototype, '_createConnection', wrapPoolMethod)

  return Pool
})

addHook({ name, file: 'lib/pool.js', versions: ['>=3.5.1'], patchDefault: true }, (Pool) => {
  shimmer.wrap(Pool.prototype, '_createPoolConnection', wrapPoolMethod)

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

// mariadb >= 3.5.1 migrated to pure ESM. require(esm) in Node.js does not trigger
// module.register() hooks, so iitm cannot intercept internal ESM files.
// Instead, hook the public entry points (callback.js / promise.js) via ritm and wrap
// query/execute methods on connection and pool instances directly.
addHook({ name, file: 'callback.js', versions: ['>=3.5.1'] }, (mariadbCallback) => {
  const wrapped = {}
  for (const key of Object.keys(mariadbCallback)) {
    wrapped[key] = mariadbCallback[key]
  }

  wrapped.createConnection = function (opts) {
    const conn = mariadbCallback.createConnection(opts)
    shimmer.wrap(conn, 'query', createWrapQueryCallback(opts))
    shimmer.wrap(conn, 'execute', createWrapQueryCallback(opts))
    return conn
  }

  wrapped.createPool = function (opts) {
    const pool = mariadbCallback.createPool(opts)
    shimmer.wrap(pool, 'query', createWrapQueryCallback(opts))
    shimmer.wrap(pool, 'execute', createWrapQueryCallback(opts))
    return pool
  }

  return wrapped
})

addHook({ name, versions: ['>=3.5.1'] }, (mariadbPromise) => {
  const wrapped = {}
  for (const key of Object.keys(mariadbPromise)) {
    wrapped[key] = mariadbPromise[key]
  }

  wrapped.createConnection = function (opts) {
    return mariadbPromise.createConnection(opts).then(function (conn) {
      shimmer.wrap(conn, 'query', createWrapQuery(opts))
      shimmer.wrap(conn, 'execute', createWrapQuery(opts))
      return conn
    })
  }

  wrapped.createPool = function (opts) {
    const pool = mariadbPromise.createPool(opts)
    shimmer.wrap(pool, 'query', createWrapQuery(opts))
    shimmer.wrap(pool, 'execute', createWrapQuery(opts))
    return pool
  }

  return wrapped
})
