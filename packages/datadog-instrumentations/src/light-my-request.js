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
  addHook
} = require('./helpers/instrument')

// Reuse the same channels as HTTP server instrumentation
const startServerCh = channel('apm:http:server:request:start')
const exitServerCh = channel('apm:http:server:request:exit')
const errorServerCh = channel('apm:http:server:request:error')
const finishServerCh = channel('apm:http:server:request:finish')

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

    // Track when response finishes via 'finish' event (like HTTP instrumentation)
    let finishCalled = false
    const onFinish = () => {
      if (!finishCalled) {
        finishCalled = true
        finishServerCh.publish({ req })
      }
    }

    // light-my-request Response emits 'finish' when done
    if (res.on && typeof res.on === 'function') {
      res.on('finish', onFinish)
      res.on('close', onFinish)
    }

    // Also wrap end() as fallback
    const originalEnd = res.end
    if (originalEnd) {
      res.end = function wrappedEnd () {
        const result = originalEnd.apply(this, arguments)
        // Trigger finish if events don't fire
        setImmediate(onFinish)
        return result
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
