'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

addHook({ name: 'memcached', versions: ['>=2.2'] }, Memcached => {
  const startCh = channel('apm:memcached:command:start')
  const finishCh = channel('apm:memcached:command:finish')
  const errorCh = channel('apm:memcached:command:error')

  shimmer.wrap(Memcached.prototype, 'command', command => function (queryCompiler, server) {
    if (!startCh.hasSubscribers) {
      return Reflect.apply(command, this, arguments)
    }

    const callbackResource = new AsyncResource('bound-anonymous-fn')
    const asyncResource = new AsyncResource('bound-anonymous-fn')

    const client = this

    const wrappedQueryCompiler = asyncResource.bind(function () {
      const query = Reflect.apply(queryCompiler, this, arguments)
      const callback = callbackResource.bind(query.callback)

      query.callback = shimmer.wrapFunction(callback, callback => asyncResource.bind(function (err) {
        if (err) {
          errorCh.publish(err)
        }
        finishCh.publish()

        return Reflect.apply(callback, this, arguments)
      }))
      startCh.publish({ client, server, query })

      return query
    })

    return asyncResource.runInAsyncScope(() => {
      arguments[0] = wrappedQueryCompiler

      const result = Reflect.apply(command, this, arguments)

      return result
    })
  })

  return Memcached
})
