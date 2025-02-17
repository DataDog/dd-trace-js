'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

addHook({ name: 'mysql', file: 'lib/Connection.js', versions: ['>=2'] }, Connection => {
  const startCh = channel('apm:mysql:query:start')
  const finishCh = channel('apm:mysql:query:finish')
  const errorCh = channel('apm:mysql:query:error')

  shimmer.wrap(Connection.prototype, 'query', query => function () {
    if (!startCh.hasSubscribers) {
      return Reflect.apply(query, this, arguments)
    }

    const sql = arguments[0].sql || arguments[0]
    const conf = this.config
    const payload = { sql, conf }

    const callbackResource = new AsyncResource('bound-anonymous-fn')
    const asyncResource = new AsyncResource('bound-anonymous-fn')

    return asyncResource.runInAsyncScope(() => {
      startCh.publish(payload)

      if (arguments[0].sql) {
        arguments[0].sql = payload.sql
      } else {
        arguments[0] = payload.sql
      }
      try {
        const res = Reflect.apply(query, this, arguments)

        if (res._callback) {
          const cb = callbackResource.bind(res._callback)
          res._callback = shimmer.wrapFunction(cb, cb => asyncResource.bind(function (error, result) {
            if (error) {
              errorCh.publish(error)
            }
            finishCh.publish(result)

            return Reflect.apply(cb, this, arguments)
          }))
        } else {
          const cb = asyncResource.bind(function () {
            finishCh.publish()
          })
          res.on('end', cb)
        }

        return res
      } catch (err) {
        err.stack // trigger getting the stack at the original throwing point
        errorCh.publish(err)

        throw err
      }
    })
  })

  return Connection
})

addHook({ name: 'mysql', file: 'lib/Pool.js', versions: ['>=2'] }, Pool => {
  const startPoolQueryCh = channel('datadog:mysql:pool:query:start')
  const finishPoolQueryCh = channel('datadog:mysql:pool:query:finish')

  shimmer.wrap(Pool.prototype, 'getConnection', getConnection => function (cb) {
    arguments[0] = AsyncResource.bind(cb)
    return Reflect.apply(getConnection, this, arguments)
  })

  shimmer.wrap(Pool.prototype, 'query', query => function () {
    if (!startPoolQueryCh.hasSubscribers) {
      return Reflect.apply(query, this, arguments)
    }

    const asyncResource = new AsyncResource('bound-anonymous-fn')

    const sql = arguments[0].sql || arguments[0]

    return asyncResource.runInAsyncScope(() => {
      startPoolQueryCh.publish({ sql })

      const finish = asyncResource.bind(function () {
        finishPoolQueryCh.publish()
      })

      const cb = arguments[arguments.length - 1]
      if (typeof cb === 'function') {
        arguments[arguments.length - 1] = shimmer.wrapFunction(cb, cb => function () {
          finish()
          return Reflect.apply(cb, this, arguments)
        })
      }

      const retval = Reflect.apply(query, this, arguments)

      if (retval && retval.then) {
        retval.then(finish).catch(finish)
      }

      return retval
    })
  })

  return Pool
})
