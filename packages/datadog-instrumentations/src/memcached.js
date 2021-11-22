'use strict'

const { AsyncResource } = require('async_hooks')
const {
  channel,
  addHook,
  bind,
  bindAsyncResource
} = require('../../dd-trace/src/plugins/instrument')

addHook({ name: 'memcached', versions: ['>=2.2'] }, Memcached => {
  const startCh = channel('apm:memcached:command:start')
  const startQueryCbCh = channel('apm:memcached:query-cb:start')
  const asyncEndQueryCbCh = channel('apm:memcached:query-cb:async-end')
  const endCh = channel('apm:memcached:command:end')
  const command = Memcached.prototype.command

  Memcached.prototype.command = function (queryCompiler, server) {
    if (!startCh.hasSubscribers) {
      return command.apply(this, arguments)
    }

    const asyncResource = new AsyncResource('bound-anonymous-fn')

    const client = this

    const wrappedQueryCompiler = function () {
      const query = queryCompiler.apply(this, arguments)
      const callback = bindAsyncResource.call(asyncResource, query.callback)

      query.callback = bind(function (err) {
        asyncEndQueryCbCh.publish(err)

        return callback.apply(this, arguments)
      })
      startQueryCbCh.publish({ client, server, query })

      return query
    }

    startCh.publish(undefined)

    arguments[0] = wrappedQueryCompiler

    const result = command.apply(this, arguments)
    endCh.publish(undefined)
    return result
  }

  Reflect.ownKeys(command).forEach(key => {
    Object.defineProperty(
      Memcached.prototype.command,
      key,
      Object.getOwnPropertyDescriptor(command, key)
    )
  })

  return Memcached
})
