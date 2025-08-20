'use strict'

// Old instrumentation temporarily replaced with compatibility mode only instrumentation.
// See https://github.com/DataDog/dd-trace-js/issues/312

const {
  channel,
  addHook
} = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

const startServerCh = channel('apm:http2:server:request:start')
const errorServerCh = channel('apm:http2:server:request:error')
const emitCh = channel('apm:http2:server:response:emit')

const names = ['http2', 'node:http2']

addHook({ name: names }, http2 => {
  shimmer.wrap(http2, 'createSecureServer', wrapCreateServer)
  if (http2.default) http2.default.createSecureServer = http2.createSecureServer
  shimmer.wrap(http2, 'createServer', wrapCreateServer)
  if (http2.default) http2.default.createServer = http2.createServer
})

function wrapCreateServer (createServer) {
  return function (...args) {
    const server = createServer.apply(this, args)
    shimmer.wrap(server, 'emit', wrapEmit)
    return server
  }
}

function wrapResponseEmit (emit, ctx) {
  return function (eventName, event) {
    ctx.req = this.req
    ctx.eventName = eventName
    return emitCh.runStores(ctx, emit, this, ...arguments)
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
        shimmer.wrap(res, 'emit', emit => wrapResponseEmit(emit, ctx))

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
