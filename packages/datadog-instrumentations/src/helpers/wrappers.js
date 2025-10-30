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

/**
 * Wraps a constructor to gain access to instance methods or callbacks
 *
 * Use cases:
 * 1. Access pattern: Wrap instance methods that aren't accessible via exports
 * 2. Callback pattern: Wrap callbacks passed to constructor (e.g., BullMQ Worker)
 *
 * NOTE: The constructor itself is NOT traced. This just provides access to wrap
 * methods/callbacks that will be traced when they're invoked.
 *
 * @param {string} channelName - Channel name for the wrapped method/callback (NOT the constructor)
 * @param {Object} options - Configuration options
 * @param {Array<string>} [options.wrapMethods] - Instance methods to wrap after construction
 * @param {number} [options.callbackIndex] - Index of callback argument in constructor
 * @param {string} [options.operator] - Operator for wrapping (default: 'tracePromise')
 * @returns {function} Constructor wrapper
 *
 * @example
 * // Access pattern - wrap instance method that's not exported
 * // The wrapped method will be traced, NOT the constructor
 * const wrapClient = createConstructorWrapper('apm:db:client:connect', {
 *   wrapMethods: ['connect']
 * })
 * shimmer.wrap(dbLib, 'Client', wrapClient)
 *
 * @example
 * // Callback pattern - wrap callback passed to constructor
 * // The callback invocations will be traced, NOT the constructor
 * const wrapWorker = createConstructorWrapper('apm:bullmq:worker:process', {
 *   callbackIndex: 1,  // Second argument is the process callback
 *   operator: 'traceHandler'
 * })
 * shimmer.wrap(bullmq, 'Worker', wrapWorker)
 */
function createConstructorWrapper (channelName, options = {}) {
  const { wrapMethods = [], callbackIndex = -1, operator = 'tracePromise' } = options

  return function (Constructor) {
    return class extends Constructor {
      constructor (...args) {
        // Wrap callback if specified (callback pattern)
        if (callbackIndex >= 0 && callbackIndex < args.length) {
          const originalCallback = args[callbackIndex]
          if (typeof originalCallback === 'function') {
            // Create wrapper using the specified operator
            const wrapper = createWrapper(channelName, operator)
            args[callbackIndex] = wrapper(originalCallback)
          }
        }

        // Call original constructor
        super(...args)

        // Wrap instance methods if specified (access pattern)
        for (const methodName of wrapMethods) {
          if (this[methodName] && typeof this[methodName] === 'function') {
            const wrapper = createWrapper(channelName, operator)
            this[methodName] = wrapper(this[methodName])
          }
        }
      }
    }
  }
}

module.exports = {
  createWrapper,
  createEventWrapper,
  createConstructorWrapper
}
