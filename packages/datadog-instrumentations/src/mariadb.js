'use strict'

const { channel, addHook, AsyncResource } = require('./helpers/instrument')

const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:mariadb:query:start')
const finishCh = channel('apm:mariadb:query:finish')
const errorCh = channel('apm:mariadb:query:error')
const skipCh = channel('apm:mariadb:pool:skip')
const unskipCh = channel('apm:mariadb:pool:unskip')

function wrapCommandStart (start, callbackResource) {
  return shimmer.wrapFunction(start, start => function () {
    if (!startCh.hasSubscribers) return Reflect.apply(start, this, arguments)

    const resolve = callbackResource.bind(this.resolve)
    const reject = callbackResource.bind(this.reject)

    const asyncResource = callbackResource.runInAsyncScope(() => new AsyncResource('bound-anonymous-fn'))

    shimmer.wrap(this, 'resolve', function wrapResolve () {
      return function () {
        asyncResource.runInAsyncScope(() => {
          finishCh.publish()
        })

        return Reflect.apply(resolve, this, arguments)
      }
    })

    shimmer.wrap(this, 'reject', function wrapReject () {
      return function (error) {
        asyncResource.runInAsyncScope(() => {
          errorCh.publish(error)
          finishCh.publish()
        })

        return Reflect.apply(reject, this, arguments)
      }
    })

    return asyncResource.runInAsyncScope(() => {
      startCh.publish({ sql: this.sql, conf: this.opts })
      return Reflect.apply(start, this, arguments)
    })
  })
}

function wrapCommand (Command) {
  return class extends Command {
    constructor (...args) {
      super(...args)

      const callbackResource = new AsyncResource('bound-anonymous-fn')

      if (this.start) {
        this.start = wrapCommandStart(this.start, callbackResource)
      }
    }
  }
}

function createWrapQuery (options) {
  return function wrapQuery (query) {
    return function (sql) {
      if (!startCh.hasSubscribers) return Reflect.apply(query, this, arguments)

      const asyncResource = new AsyncResource('bound-anonymous-fn')

      return asyncResource.runInAsyncScope(() => {
        startCh.publish({ sql, conf: options })

        return Reflect.apply(query, this, arguments)
          .then(result => {
            finishCh.publish()
            return result
          }, error => {
            errorCh.publish(error)
            finishCh.publish()
            throw error
          })
      }, 'bound-anonymous-fn')
    }
  }
}

function createWrapQueryCallback (options) {
  return function wrapQuery (query) {
    return function (sql) {
      if (!startCh.hasSubscribers) return Reflect.apply(query, this, arguments)

      const cb = arguments[arguments.length - 1]
      const asyncResource = new AsyncResource('bound-anonymous-fn')
      const callbackResource = new AsyncResource('bound-anonymous-fn')

      if (typeof cb !== 'function') {
        arguments.length = arguments.length + 1
      }

      arguments[arguments.length - 1] = shimmer.wrapFunction(cb, cb => asyncResource.bind(function (err) {
        if (err) {
          errorCh.publish(err)
        }

        finishCh.publish()

        if (typeof cb === 'function') {
          return callbackResource.runInAsyncScope(() => Reflect.apply(cb, this, arguments))
        }
      }))

      return asyncResource.runInAsyncScope(() => {
        startCh.publish({ sql, conf: options })

        return Reflect.apply(query, this, arguments)
      }, 'bound-anonymous-fn')
    }
  }
}

function wrapConnection (promiseMethod, Connection) {
  return function (options) {
    Reflect.apply(Connection, this, arguments)

    shimmer.wrap(this, promiseMethod, createWrapQuery(options))
    shimmer.wrap(this, '_queryCallback', createWrapQueryCallback(options))
  }
}

function wrapPoolBase (PoolBase) {
  return function (options, processTask, createConnectionPool, pingPromise) {
    arguments[1] = wrapPoolMethod(processTask)
    arguments[2] = wrapPoolMethod(createConnectionPool)

    Reflect.apply(PoolBase, this, arguments)

    shimmer.wrap(this, 'query', createWrapQuery(options.connOptions))
  }
}

// It's not possible to prevent connection pools from leaking across queries,
// so instead we just skip instrumentation completely to avoid memory leaks
// and/or orphan spans.
function wrapPoolMethod (createConnection) {
  return function () {
    skipCh.publish()
    try {
      return Reflect.apply(createConnection, this, arguments)
    } finally {
      unskipCh.publish()
    }
  }
}

const name = 'mariadb'

addHook({ name, file: 'lib/cmd/query.js', versions: ['>=3'] }, (Query) => {
  return wrapCommand(Query)
})

addHook({ name, file: 'lib/cmd/execute.js', versions: ['>=3'] }, (Execute) => {
  return wrapCommand(Execute)
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
