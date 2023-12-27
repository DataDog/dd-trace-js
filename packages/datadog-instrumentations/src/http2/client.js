'use strict'

const shimmer = require('../../../datadog-shimmer')
const { addHook, channel } = require('../helpers/instrument')

const connectChannel = channel('apm:http2:client:connect:start')
const startChannel = channel('apm:http2:client:request:start')
const endChannel = channel('apm:http2:client:request:end')
const asyncStartChannel = channel('apm:http2:client:request:asyncStart')
const asyncEndChannel = channel('apm:http2:client:request:asyncEnd')
const errorChannel = channel('apm:http2:client:request:error')

const names = ['http2', 'node:http2']

function createWrapEmit (ctx) {
  return function wrapEmit (emit) {
    return function (event, arg1) {
      ctx.eventName = event
      ctx.eventData = arg1

      return asyncStartChannel.runStores(ctx, () => {
        try {
          return emit.apply(this, arguments)
        } finally {
          asyncEndChannel.publish(ctx)
        }
      })
    }
  }
}

function createWrapRequest (authority, options) {
  return function wrapRequest (request) {
    return function (headers) {
      if (!startChannel.hasSubscribers) return request.apply(this, arguments)

      const ctx = { headers, authority, options }

      return startChannel.runStores(ctx, () => {
        try {
          const req = request.apply(this, arguments)

          shimmer.wrap(req, 'emit', createWrapEmit(ctx))

          return req
        } catch (e) {
          ctx.error = e
          errorChannel.publish(ctx)
          throw e
        } finally {
          endChannel.publish(ctx)
        }
      })
    }
  }
}

function wrapConnect (connect) {
  return function (authority, options) {
    if (connectChannel.hasSubscribers) {
      connectChannel.publish({ authority })
    }
    const session = connect.apply(this, arguments)

    shimmer.wrap(session, 'request', createWrapRequest(authority, options))

    return session
  }
}

addHook({ name: names }, http2 => {
  shimmer.wrap(http2, 'connect', wrapConnect)

  return http2
})
