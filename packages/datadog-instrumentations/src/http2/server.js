'use strict'

// Old instrumentation temporarily replaced with compatibility mode only instrumentation.
// See https://github.com/DataDog/dd-trace-js/issues/312

const {
  channel,
  addHook
} = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')
const { storage } = require('../../../datadog-core')

const startServerCh = channel('apm:http2:server:request:start')
const errorServerCh = channel('apm:http2:server:request:error')
const finishServerCh = channel('apm:http2:server:request:finish')

const names = ['http2', 'node:http2']

addHook({ name: names }, http2 => {
  shimmer.wrap(http2, 'createSecureServer', wrapCreateServer)
  shimmer.wrap(http2, 'createServer', wrapCreateServer)
  return http2
})

function wrapCreateServer (createServer) {
  return function (...args) {
    const server = createServer.apply(this, args)
    shimmer.wrap(server, 'emit', wrapEmit)
    return server
  }
}

function wrapResponseEmit (emit, ctx, store) {
  return function (eventName, event) {
    storage('legacy').enterWith(store)
    ctx.req = this.req
    ctx.eventName = eventName
    return finishServerCh.runStores(ctx, () => {
      return emit.apply(this, arguments)
    })
  }
}
function wrapEmit (emit) {
  return function (eventName, req, res) {
    if (!startServerCh.hasSubscribers) {
      return emit.apply(this, arguments)
    }

    if (eventName === 'request') {
      res.req = req

      const ctx = { req, res }
      return startServerCh.runStores(ctx, () => {
        const store = storage('legacy').getStore()
        shimmer.wrap(res, 'emit', emit => wrapResponseEmit(emit, ctx, store))

        try {
          return emit.apply(this, arguments)
        } catch (error) {
          ctx.error = error
          errorServerCh.publish(ctx)

          throw error
        }
      })
    }
    return emit.apply(this, arguments)
  }
}
