'use strict'

// Old instrumentation temporarily replaced with compatibility mode only instrumentation.
// See https://github.com/DataDog/dd-trace-js/issues/312

const {
  channel,
  addHook,
} = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

const startServerCh = channel('apm:http2:server:request:start')
const errorServerCh = channel('apm:http2:server:request:error')
const emitCh = channel('apm:http2:server:response:emit')

addHook({ name: 'http2' }, http2 => {
  shimmer.wrap(http2, 'createSecureServer', wrapCreateServer)
  shimmer.wrap(http2, 'createServer', wrapCreateServer)
})

function wrapCreateServer (createServer) {
  return function (...args) {
    const server = createServer.apply(this, args)
    shimmer.wrap(server, 'emit', wrapEmit)
    return server
  }
}

function wrapResponseEmit (emit, ctx) {
  return function (...args) {
    ctx.req = this.req
    ctx.eventName = args[0]
    return emitCh.runStores(ctx, emit, this, ...args)
  }
}

function wrapEmit (emit) {
  // Rest params + Reflect.apply instead of named formals + `arguments`: naming
  // params while reading `arguments` materialises the mapped arguments object
  // on every emitted event, including the no-subscriber fast path.
  return function (...args) {
    if (!startServerCh.hasSubscribers) {
      return Reflect.apply(emit, this, args)
    }

    const eventName = args[0]
    if (eventName === 'request') {
      const req = args[1]
      const res = args[2]
      res.req = req

      const ctx = { req, res }
      return startServerCh.runStores(ctx, () => {
        shimmer.wrap(res, 'emit', emit => wrapResponseEmit(emit, ctx))

        try {
          return Reflect.apply(emit, this, args)
        } catch (error) {
          ctx.error = error
          errorServerCh.publish(ctx)

          throw error
        }
      })
    }
    return Reflect.apply(emit, this, args)
  }
}
