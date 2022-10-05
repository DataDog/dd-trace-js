'use strict'

// Old instrumentation temporarily replaced with compatibility mode only instrumentation.
// See https://github.com/DataDog/dd-trace-js/issues/312

const {
  channel,
  addHook,
  AsyncResource
} = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

const startServerCh = channel('apm:http2:server:request:start')
const errorServerCh = channel('apm:http2:server:request:error')
const finishServerCh = channel('apm:http2:server:request:finish')

addHook({ name: 'http2' }, http2 => {
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

function wrapResponseEmit (emit) {
  const asyncResource = new AsyncResource('bound-anonymous-fn')
  return function (eventName, event) {
    return asyncResource.runInAsyncScope(() => {
      if (eventName === 'close' && finishServerCh.hasSubscribers) {
        finishServerCh.publish({ req: this.req })
      }

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

      const asyncResource = new AsyncResource('bound-anonymous-fn')
      return asyncResource.runInAsyncScope(() => {
        startServerCh.publish({ req, res })

        shimmer.wrap(res, 'emit', wrapResponseEmit)

        try {
          return emit.apply(this, arguments)
        } catch (err) {
          errorServerCh.publish(err)

          throw err
        }
      })
    }
    return emit.apply(this, arguments)
  }
}
