'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

addHook({ name: 'mysql', file: 'lib/Connection.js', versions: ['>=2'] }, Connection => {
  const startCh = channel('apm:mysql:query:start')
  const asyncEndCh = channel('apm:mysql:query:async-end')
  const endCh = channel('apm:mysql:query:end')
  const errorCh = channel('apm:mysql:query:error')

  shimmer.wrap(Connection.prototype, 'query', query => function () {
    const asyncResource = new AsyncResource('bound-anonymous-fn')
    if (!startCh.hasSubscribers) {
      return query.apply(this, arguments)
    }

    const sql = arguments[0].sql ? arguments[0].sql : arguments[0]
    const startArgs = [sql, this.config]

    startCh.publish(startArgs)

    try {
      const res = query.apply(this, arguments)

      if (res._callback) {
        const cb = asyncResource.bind(res._callback)
        res._callback = AsyncResource.bind(function (error, result) {
          if (error) {
            errorCh.publish(error)
          }
          asyncEndCh.publish(result)

          return cb.apply(this, arguments)
        })
      } else {
        const cb = AsyncResource.bind(function () {
          asyncEndCh.publish(undefined)
        })
        res.on('end', cb)
      }

      return res
    } catch (err) {
      err.stack // trigger getting the stack at the original throwing point
      errorCh.publish(err)

      throw err
    } finally {
      endCh.publish(undefined)
    }
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
