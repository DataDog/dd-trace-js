'use strict'

const { tracingChannel } = require('dc-polyfill')

function createWrapper (channelName, operator) {
  const channel = tracingChannel(channelName)

  return function (original) {
    return function (...args) {
      const ctx = {
        self: this,
        arguments: args,
        args
      }

      if (operator === 'tracePromise') {
        return channel.tracePromise(original, ctx, this, ...args)
      } else if (operator === 'traceSync') {
        return channel.traceSync(original, ctx, this, ...args)
      } else if (operator === 'traceCallback') {
        return channel.traceCallback(original, -1, ctx, this, ...args)
      } else if (operator === 'traceHandler') {
        const handlerIndex = args.findIndex(a => typeof a === 'function')
        if (handlerIndex === -1) {
          return original.apply(this, args)
        }

        const originalHandler = args[handlerIndex]
        args[handlerIndex] = function wrappedHandler (...handlerArgs) {
          const handlerCtx = {
            self: ctx.self,
            args: handlerArgs,
            handler: originalHandler
          }

          return channel.asyncStart.runStores(handlerCtx, () => {
            try {
              const result = originalHandler.apply(ctx.self, handlerArgs)
              if (result && typeof result.then === 'function') {
                return result.then(
                  res => {
                    channel.asyncEnd.publish(handlerCtx)
                    return res
                  },
                  err => {
                    handlerCtx.error = err
                    channel.error.publish(handlerCtx)
                    channel.asyncEnd.publish(handlerCtx)
                    throw err
                  }
                )
              }
              channel.asyncEnd.publish(handlerCtx)
              return result
            } catch (e) {
              handlerCtx.error = e
              channel.error.publish(handlerCtx)
              channel.asyncEnd.publish(handlerCtx)
              throw e
            }
          })
        }

        return original.apply(this, args)
      }
      return original.apply(this, args)
    }
  }
}

function createEventWrapper (channelName, finishEventName) {
  const channel = tracingChannel(channelName)

  return function (original) {
    return function (...args) {
      const ctx = {
        this: this,
        args
      }

      const callback = args[args.length - 1]
      const eventName = args[args.length - 2]

      if (typeof callback !== 'function') {
        return original.apply(this, args)
      }

      if (eventName !== finishEventName) {
        return original.apply(this, args)
      }

      return channel.traceCallback(original, -1, ctx, this, ...args)
    }
  }
}

module.exports = {
  createWrapper,
  createEventWrapper
}
