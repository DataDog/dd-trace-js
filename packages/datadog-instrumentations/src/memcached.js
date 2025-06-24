'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

addHook({ name: 'memcached', versions: ['>=2.2'] }, Memcached => {
  const startCh = channel('apm:memcached:command:start')
  const finishCh = channel('apm:memcached:command:finish')
  const errorCh = channel('apm:memcached:command:error')

  shimmer.wrap(Memcached.prototype, 'command', command => function (queryCompiler, server) {
    if (!startCh.hasSubscribers) {
      return command.apply(this, arguments)
    }

    const client = this

    const wrappedQueryCompiler = function () {
      const query = queryCompiler.apply(this, arguments)

      const ctx = { client, server, query }
      startCh.runStores(ctx, () => {
        query.callback = shimmer.wrapFunction(query.callback, callback => function (err) {
          if (err) {
            ctx.error = err
            errorCh.publish(ctx)
          }
          finishCh.publish(ctx)

          return finishCh.runStores(ctx, callback, this, ...arguments)
        })
      })
      return query
    }

    arguments[0] = wrappedQueryCompiler

    return command.apply(this, arguments)
  })

  return Memcached
})
