'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

addHook({ name: 'memcached', versions: ['>=2.2'] }, Memcached => {
  const startCh = channel('apm:memcached:command:start')
  const startWithArgsCh = channel('apm:memcached:command:start:with-args')
  const finishCh = channel('apm:memcached:command:finish')
  const errorCh = channel('apm:memcached:command:error')

  shimmer.wrap(Memcached.prototype, 'command', command => function (queryCompiler, server) {
    if (!startCh.hasSubscribers) {
      return command.apply(this, arguments)
    }

    const callbackResource = new AsyncResource('bound-anonymous-fn')
    const asyncResource = new AsyncResource('bound-anonymous-fn')

    const client = this

    const wrappedQueryCompiler = asyncResource.bind(function () {
      const query = queryCompiler.apply(this, arguments)
      const callback = callbackResource.bind(query.callback)

      query.callback = asyncResource.bind(function (err) {
        if (err) {
          errorCh.publish(err)
        }
        finishCh.publish()

        return callback.apply(this, arguments)
      })
      startWithArgsCh.publish({ client, server, query })

      return query
    })

    return asyncResource.runInAsyncScope(() => {
      startCh.publish()

      arguments[0] = wrappedQueryCompiler

      const result = command.apply(this, arguments)

      return result
    })
  })

  return Memcached
})
