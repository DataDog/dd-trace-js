'use strict'

const { channel, addHook } = require('./helpers/instrument')

const shimmer = require('../../datadog-shimmer')

const commandAddCh = channel('apm:mariadb:command:add')
const connectionStartCh = channel('apm:mariadb:connection:start')
const connectionFinishCh = channel('apm:mariadb:connection:finish')
const startCh = channel('apm:mariadb:query:start')
const finishCh = channel('apm:mariadb:query:finish')
const errorCh = channel('apm:mariadb:query:error')
const skipCh = channel('apm:mariadb:pool:skip')

function wrapCommandStart (start, ctx) {
  return shimmer.wrapFunction(start, start => function () {
    if (!startCh.hasSubscribers) return start.apply(this, arguments)

    const { reject, resolve } = this
    shimmer.wrap(this, 'resolve', function wrapResolve () {
      return function () {
        return finishCh.runStores(ctx, resolve, this, ...arguments)
      }
    })

    shimmer.wrap(this, 'reject', function wrapReject () {
      return function (error) {
        ctx.error = error

        errorCh.publish(ctx)

        return finishCh.runStores(ctx, reject, this, ...arguments)
      }
    })

    return startCh.runStores(ctx, start, this, ...arguments)
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
          ctx.error
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

      if (typeof cb !== 'function') {
        arguments.length += 1
      }

      arguments[arguments.length - 1] = shimmer.wrapFunction(cb, cb => function (err) {
        if (err) {
          ctx.error = err
          errorCh.publish(ctx)
        }

        return typeof cb === 'function'
          ? finishCh.runStores(ctx, cb, this, ...arguments)
          : finishCh.publish(ctx)
      })

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
  return function () {
    return skipCh.runStores({}, createConnection, this, ...arguments)
  }
}

function wrapPoolGetConnectionMethod (getConnection) {
  return function wrappedGetConnection () {
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

addHook({ name, file: 'lib/cmd/query.js', versions: ['>=3'] }, (Query) => {
  return wrapCommand(Query)
})

addHook({ name, file: 'lib/cmd/execute.js', versions: ['>=3'] }, (Execute) => {
  return wrapCommand(Execute)
})

// in 3.4.1 getConnection method start to use callbacks instead of promises
addHook({ name, file: 'lib/pool.js', versions: ['>=3.4.1'] }, (Pool) => {
  shimmer.wrap(Pool.prototype, 'getConnection', wrapPoolGetConnectionMethod)

  return Pool
})

addHook({ name, file: 'lib/pool.js', versions: ['>=3'] }, (Pool) => {
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
