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
      return query.apply(this, arguments)
    }

    const sql = arguments[0].sql ? arguments[0].sql : arguments[0]
    const conf = this.config

    const callbackResource = new AsyncResource('bound-anonymous-fn')
    const asyncResource = new AsyncResource('bound-anonymous-fn')

    return asyncResource.runInAsyncScope(() => {
      startCh.publish({ sql, conf })

      try {
        const res = query.apply(this, arguments)

        if (res._callback) {
          const cb = callbackResource.bind(res._callback)
          res._callback = asyncResource.bind(function (error, result) {
            if (error) {
              errorCh.publish(error)
            }
            finishCh.publish(result)

            return cb.apply(this, arguments)
          })
        } else {
          const cb = asyncResource.bind(function () {
            finishCh.publish(undefined)
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
  shimmer.wrap(Pool.prototype, 'getConnection', getConnection => function (cb) {
    arguments[0] = AsyncResource.bind(cb)
    return getConnection.apply(this, arguments)
  })
  return Pool
})
