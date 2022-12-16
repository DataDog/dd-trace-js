'use strict'

const { channel } = require('diagnostics_channel')
const Hook = require('../../../../packages/dd-trace/src/ritm')

const startChannel = channel('apm:koa:request:start')
const endChannel = channel('apm:koa:request:end')
const errorChannel = channel('apm:koa:request:error')
const asyncEndChannel = channel('apm:koa:request:async-end')

Hook(['koa'], function (Koa, name, basedir) {
  if (name !== 'koa/lib/application.js') return Koa

  const { handleRequest } = Koa.prototype

  Koa.prototype.handleRequest = function (ctx, fnMiddleware) {
    startChannel.publish(ctx)

    const promise = handleRequest.apply(this, arguments)
      .then(() => asyncEndChannel.publish(ctx), error => {
        errorChannel.publish(error)
        asyncEndChannel.publish(ctx)
        throw error
      })

    endChannel.publish(ctx)

    return promise
  }

  return Koa
})
