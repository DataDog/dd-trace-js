'use strict'

const { tracingChannel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')
const { addHook } = require('./helpers/instrument')

const typesafeTracingChannel = tracingChannel('apm:typesafe:request')

/**
 * @param {boolean} serializesAssets - Whether this SDK version runs its asset-aware serializer (0.7.0+)
 * @returns {(systemOne: Function) => Function}
 */
function wrapSystemOne (serializesAssets) {
  return systemOne => wrapSystemOneMethod(systemOne, serializesAssets)
}

/**
 * Shimmer instead of Orchestrion: `systemOne` returns the SDK's lazy `APIPromise` subclass, which must reach the
 * caller unchanged (`asResponse()`, `withResponse()`, `map()`). Awaiting it here would run the SDK's body parse and
 * consume the response that `asResponse()` callers read themselves, so the result is read from a clone instead.
 *
 * @param {Function} systemOne
 * @param {boolean} serializesAssets
 * @returns {Function}
 */
function wrapSystemOneMethod (systemOne, serializesAssets) {
  return function (...args) {
    if (!typesafeTracingChannel.start.hasSubscribers) {
      return systemOne.apply(this, args)
    }

    const ctx = {
      request: args[0],
      baseURL: this.baseURL,
      defaultModel: this.defaultModel,
      serializesAssets,
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
 * Reads the body from a clone so the caller's response stays unread. The raw text is kept for the span, and parsed
 * the way the SDK does: JSON when it parses, otherwise the text itself.
 *
 * @param {object} ctx
 * @param {Response} response
 */
function readResult (ctx, response) {
  try {
    response.clone().text().then(text => {
      ctx.responseText = text
      finish(ctx, parseBody(text))
    }, error => {
      log.debug('Could not read the TypeSafe response body; the span has no result: %s', error.message)
      finish(ctx)
    })
  } catch (error) {
    log.debug('Could not read the TypeSafe response body; the span has no result: %s', error.message)
    finish(ctx)
  }
}

/**
 * @param {string} text
 */
function parseBody (text) {
  if (text.length === 0) return
  try {
    return JSON.parse(text)
  } catch {
    return text
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
  // Image assets and the serializer that writes them (and non-finite numbers) arrived together in 0.7.0
  const serializesAssets = typeof exports.withAssets === 'function'
  shimmer.wrap(exports.TypeSafeClient.prototype, 'systemOne', wrapSystemOne(serializesAssets))

  return exports
})
