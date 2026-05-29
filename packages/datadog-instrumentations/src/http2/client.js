'use strict'

const shimmer = require('../../../datadog-shimmer')
const { addHook, channel } = require('../helpers/instrument')

const connectChannel = channel('apm:http2:client:connect:start')
const startChannel = channel('apm:http2:client:request:start')
const endChannel = channel('apm:http2:client:request:end')
const asyncStartChannel = channel('apm:http2:client:request:asyncStart')
const asyncEndChannel = channel('apm:http2:client:request:asyncEnd')
const errorChannel = channel('apm:http2:client:request:error')

function createWrapEmit (ctx) {
  return function wrapEmit (emit) {
    return function (...args) {
      ctx.eventName = args[0]
      ctx.eventData = args[1]

      return asyncStartChannel.runStores(ctx, () => {
        try {
          return Reflect.apply(emit, this, args)
        } finally {
          asyncEndChannel.publish(ctx)
        }
      })
    }
  }
}

function createWrapRequest (authority, options) {
  return function wrapRequest (request) {
    return function (...args) {
      if (!startChannel.hasSubscribers) return Reflect.apply(request, this, args)

      const ctx = { headers: args[0], authority, options }

      return startChannel.runStores(ctx, () => {
        try {
          const req = Reflect.apply(request, this, args)

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
  return function (...args) {
    const authority = args[0]
    if (connectChannel.hasSubscribers) {
      connectChannel.publish({ authority })
    }
    const session = Reflect.apply(connect, this, args)

    shimmer.wrap(session, 'request', createWrapRequest(authority, args[1]))

    return session
  }
}

addHook({ name: 'http2' }, http2 => {
  shimmer.wrap(http2, 'connect', wrapConnect)
  if (http2.default) http2.default.connect = http2.connect

  return http2
})
