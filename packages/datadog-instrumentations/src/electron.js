'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, tracingChannel } = require('./helpers/instrument')

const requestCh = tracingChannel('apm:electron:net:request')

function createWrapRequest (ch) {
  return function wrapRequest (request) {
    return function (...args) {
      if (!ch.start.hasSubscribers) return request.apply(this, arguments)

      const ctx = { args }

      return ch.start.runStores(ctx, () => {
        try {
          const req = request.apply(this, ctx.args)
          const emit = req.emit

          ctx.req = req

          req.emit = function (eventName, arg) {
            /* eslint-disable no-fallthrough */
            switch (eventName) {
              case 'response':
                ctx.res = arg
                ctx.res.on('error', error => {
                  ctx.error = error
                  ch.error.publish(ctx)
                  ch.asyncStart.publish(ctx)
                })
                ctx.res.on('end', () => ch.asyncStart.publish(ctx))
                break
              case 'error':
                ctx.error = arg
                ch.error.publish(ctx)
              case 'abort':
                ch.asyncStart.publish(ctx)
            }

            return emit.apply(this, arguments)
          }

          return req
        } catch (e) {
          ctx.error = e
          ch.error.publish(ctx)
          throw e
        } finally {
          ch.end.publish(ctx)
        }
      })
    }
  }
}

addHook({ name: 'electron', versions: ['>=37.0.0'] }, electron => {
  // Electron exports a string in Node and an object in Electron.
  if (typeof electron === 'string') return electron

  // This also covers `fetch` as it uses `request` under the hood.
  shimmer.wrap(electron.net, 'request', createWrapRequest(requestCh))

  return electron
})
