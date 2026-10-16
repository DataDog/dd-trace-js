'use strict'

const { tracingChannel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')
const { addHook } = require('./helpers/instrument')

const typesafeTracingChannel = tracingChannel('apm:typesafe:request')

/**
 * Shimmer instead of Orchestrion: `systemOne` returns the SDK's lazy `APIPromise` subclass, which must reach the
 * caller unchanged (`asResponse()`, `withResponse()`, `map()`). Awaiting it here would run the SDK's body parse and
 * consume the response that `asResponse()` callers read themselves, so the result is read from a clone instead.
 *
 * @param {Function} systemOne
 * @returns {Function}
 */
function wrapSystemOne (systemOne) {
  return function (...args) {
    if (!typesafeTracingChannel.start.hasSubscribers) {
      return systemOne.apply(this, args)
    }

    const ctx = {
      request: args[0],
      baseURL: this.baseURL,
      defaultModel: this.defaultModel,
    }

    return typesafeTracingChannel.start.runStores(ctx, () => {
      let apiPromise
      try {
        apiPromise = systemOne.apply(this, args)
      } catch (error) {
        finish(ctx, undefined, error)
        throw error
      } finally {
        typesafeTracingChannel.end.publish(ctx)
      }

      if (typeof apiPromise?.asResponse === 'function') {
        apiPromise.asResponse().then(response => readResult(ctx, response), error => finish(ctx, undefined, error))
      } else {
        log.debug('TypeSafe systemOne returned no asResponse(); the span has no result.')
        finish(ctx)
      }

      return apiPromise
    })
  }
}

/**
 * Reads the body from a clone so the caller's response stays unread.
 *
 * @param {object} ctx
 * @param {Response} response
 */
function readResult (ctx, response) {
  try {
    response.clone().json().then(body => finish(ctx, body), error => {
      log.debug('Could not parse the TypeSafe response body; the span has no result: %s', error.message)
      finish(ctx)
    })
  } catch (error) {
    log.debug('Could not read the TypeSafe response body; the span has no result: %s', error.message)
    finish(ctx)
  }
}

/**
 * @param {object} ctx
 * @param {object} [result]
 * @param {Error} [error]
 */
function finish (ctx, result, error) {
  if (ctx.finished) return
  ctx.finished = true

  if (error) {
    ctx.error = error
    typesafeTracingChannel.error.publish(ctx)
  }

  ctx.result = result
  typesafeTracingChannel.asyncEnd.publish(ctx)
}

addHook({
  name: '@typesafe-ai/sdk',
  versions: ['>=0.6.0'],
}, exports => {
  shimmer.wrap(exports.TypeSafeClient.prototype, 'systemOne', wrapSystemOne)

  return exports
})
