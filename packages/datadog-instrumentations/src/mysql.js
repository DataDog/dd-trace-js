'use strict'

const { AsyncResource } = require('async_hooks')
const {
  channel,
  addHook,
  bind,
  bindAsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

addHook({ name: 'mysql', file: 'lib/Connection.js', versions: ['>=2'] }, Connection => {
  const startCh = channel('apm:mysql:query:start')
  const asyncEndCh = channel('apm:mysql:query:async-end')
  const endCh = channel('apm:mysql:query:end')
  const errorCh = channel('apm:mysql:query:error')

  shimmer.wrap(Connection.prototype, 'query', query => function () {
    const asyncResource = new AsyncResource('bound-anonymous-fn')

    if (!startCh.hasSubscribers || arguments.length === 1 || typeof arguments[arguments.length - 1] !== 'function') {
      if (arguments[0]._callback) {
        const newCb = arguments[0]._callback
        arguments[0]._callback = bind(function () {
          newCb.apply(this, arguments)
        })
      }
      return query.apply(this, arguments)
    }

    const cb = bindAsyncResource.call(asyncResource, arguments[arguments.length - 1])
    const startArgs = Array.from(arguments)
    startCh.publish(startArgs)

    arguments[arguments.length - 1] = bind(function (error, result) {
      if (error) {
        errorCh.publish(error)
      }
      asyncEndCh.publish(result)

      return cb.apply(this, arguments)
    })

    try {
      return query.apply(this, arguments)
    } catch (err) {
      err.stack
      errorCh.publish(err)

      throw err
    } finally {
      endCh.publish(undefined)
    }
  })

  return Connection
})

addHook({ name: 'mysql', file: 'lib/Pool.js', versions: ['>=2'] }, Pool => {
  shimmer.wrap(Pool.prototype, 'getConnection', getConnection => function () {
    arguments[0] = bind(arguments[0])
    return getConnection.apply(this, arguments)
  })
  return Pool
})
