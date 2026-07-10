'use strict'

/**
 * light-my-request instrumentation
 *
 * This instrumentation enables dd-trace to capture spans for Fastify inject() calls
 * which use light-my-request internally. Without this, inject() bypasses the HTTP
 * server instrumentation since it doesn't go through http.Server.emit('request').
 *
 * This is critical for platforms like Platformatic that use undici-thread-interceptor
 * to route requests between worker threads using Fastify inject().
 */

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

// Reuse the same channels as HTTP server instrumentation
const startServerCh = channel('apm:http:server:request:start')
const exitServerCh = channel('apm:http:server:request:exit')
const errorServerCh = channel('apm:http:server:request:error')
const finishServerCh = channel('apm:http:server:request:finish')
const postFinishServerCh = channel('apm:http:server:request:postfinish')

addHook({ name: 'light-my-request', versions: ['>=3'] }, (lightMyRequest) => {
  // Wrap the inject function
  return shimmer.wrapFunction(lightMyRequest, lightMyRequest => {
    return function wrappedInject (dispatchFunc, options, callback) {
      // If no subscribers, use original behavior
      if (!startServerCh.hasSubscribers) {
        return lightMyRequest.apply(this, arguments)
      }

      // Wrap the dispatch function to add tracing
      const wrappedDispatch = wrapDispatchFunc(dispatchFunc)

      // Call original with wrapped dispatch
      return lightMyRequest.call(this, wrappedDispatch, options, callback)
    }
  })
})

function wrapDispatchFunc (dispatchFunc) {
  return function tracedDispatch (req, res) {
    const abortController = new AbortController()

    // Link res.req like HTTP instrumentation does
    res.req = req

    // Publish start event (same as HTTP server)
    startServerCh.publish({ req, res, abortController })

    let finishCalled = false
    const originalEmit = res.emit
    if (typeof originalEmit === 'function') {
      res.emit = function emit (...args) {
        const eventName = args[0]
        if ((eventName === 'finish' || eventName === 'close') && !finishCalled) {
          finishCalled = true
          const ctx = { req }
          finishServerCh.publish(ctx)
          try {
            return Reflect.apply(originalEmit, this, args)
          } finally {
            postFinishServerCh.publish(ctx)
          }
        }
        return Reflect.apply(originalEmit, this, args)
      }
    }

    try {
      if (abortController.signal.aborted) {
        return
      }

      return dispatchFunc.call(this, req, res)
    } catch (err) {
      errorServerCh.publish(err)
      throw err
    } finally {
      exitServerCh.publish({ req })
    }
  }
}
