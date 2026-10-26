'use strict'

const { tracingChannel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')

const typesafeTracingChannel = tracingChannel('apm:typesafe:request')

const apiPromiseContexts = new WeakMap()
let sendingCtx

/**
 * Shimmer instead of Orchestrion: `systemOne` returns the SDK's lazy `APIPromise` subclass, which must reach the
 * caller unchanged. The span finishes on the caller's own path to the result, through the `APIPromise` wrappers below.
 *
 * @param {Function} systemOne
 * @returns {Function}
 */
function wrapSystemOne (systemOne) {
  return function (...args) {
    if (!typesafeTracingChannel.start.hasSubscribers) {
      return systemOne.apply(this, args)
    }

    const ctx = { request: args[0], baseURL: this.baseURL, defaultModel: this.defaultModel }

    return typesafeTracingChannel.start.runStores(ctx, () => {
      let apiPromise
      sendingCtx = ctx
      try {
        apiPromise = systemOne.apply(this, args)
      } catch (error) {
        finish(ctx, undefined, error)
        throw error
      } finally {
        sendingCtx = undefined
        typesafeTracingChannel.end.publish(ctx)
      }

      if (apiPromise && typeof apiPromise === 'object') apiPromiseContexts.set(apiPromise, { ctx })
      return apiPromise
    })
  }
}

/**
 * `systemOne` calls this synchronously with the body the SDK serialized, so recording it never runs the caller's
 * `toJSON` again. Requests with images pass a function that builds the multipart body, whose JSON part is recorded.
 *
 * @param {Function} fetchWithRetries
 * @returns {Function}
 */
function wrapFetchWithRetries (fetchWithRetries) {
  return function (tag, req, ...rest) {
    const ctx = sendingCtx
    if (ctx && req) {
      sendingCtx = undefined
      const { body } = req
      if (typeof body === 'function') {
        req.body = () => body().then(multipart => {
          ctx.requestBody = multipart?.payload
          return multipart
        })
      } else {
        ctx.requestBody = body
      }
    }
    return fetchWithRetries.call(this, tag, req, ...rest)
  }
}

/**
 * The parse is memoized, so once the caller starts it, observing the same parse adds no work.
 *
 * @param {object} apiPromise
 * @param {Function} then - The unwrapped `then`
 */
function observeParse (apiPromise, then) {
  const state = apiPromiseContexts.get(apiPromise)
  if (!state || state.observed) return
  state.observed = true

  const { ctx, mapped } = state
  then.call(apiPromise, mapped ? undefined : result => finish(ctx, result), error => finish(ctx, undefined, error))
}

/**
 * @param {object} prototype - `APIPromise.prototype`
 */
function wrapAPIPromise (prototype) {
  const { then } = prototype

  for (const method of ['then', 'catch', 'finally', 'withResponse']) {
    shimmer.wrap(prototype, method, original => function (...args) {
      observeParse(this, then)
      return original.apply(this, args)
    })
  }

  shimmer.wrap(prototype, 'map', map => function (fn, ...rest) {
    const state = apiPromiseContexts.get(this)
    if (!state || typeof fn !== 'function') return map.call(this, fn, ...rest)

    const { ctx } = state
    const mapped = map.call(this, function (result) {
      finish(ctx, result)
      return fn.apply(this, arguments)
    }, ...rest)
    if (mapped && typeof mapped === 'object') apiPromiseContexts.set(mapped, { ctx, mapped: true })
    return mapped
  })

  // The caller reads the raw body itself, so the span finishes when it does
  shimmer.wrap(prototype, 'asResponse', asResponse => function (...args) {
    const responsePromise = asResponse.apply(this, args)
    const state = apiPromiseContexts.get(this)
    if (!state || state.observed) return responsePromise
    state.observed = true

    const { ctx } = state
    responsePromise.then(response => wrapRawResponse(response, ctx), error => finish(ctx, undefined, error))
    return responsePromise
  })
}

/**
 * @param {Response} response
 * @param {object} ctx
 */
function wrapRawResponse (response, ctx) {
  if (!response || typeof response !== 'object') return finish(ctx)

  wrapResponseReader(response, 'text', ctx, parseBody)
  wrapResponseReader(response, 'json', ctx)

  if (typeof response.clone !== 'function') return
  shimmer.wrap(response, 'clone', clone => function (...args) {
    const cloned = clone.apply(this, args)
    wrapRawResponse(cloned, ctx)
    return cloned
  })
}

/**
 * @param {Response} response
 * @param {'text'|'json'} method
 * @param {object} ctx
 * @param {(body: unknown) => unknown} [toResult]
 */
function wrapResponseReader (response, method, ctx, toResult) {
  if (typeof response[method] !== 'function') return

  shimmer.wrap(response, method, read => function (...args) {
    return read.apply(this, args).then(body => {
      finish(ctx, toResult ? toResult(body) : body)
      return body
    }, error => {
      finish(ctx, undefined, error)
      throw error
    })
  })
}

/**
 * Parses the body the way the SDK does: JSON when it parses, otherwise the text itself.
 *
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
 * @param {unknown} [result]
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
  const { prototype } = exports.TypeSafeClient
  shimmer.wrap(prototype, 'systemOne', wrapSystemOne)
  // TypeScript-private, so not a public contract: when it is missing, the span records the request as passed
  if (typeof prototype.fetchWithRetries === 'function') {
    shimmer.wrap(prototype, 'fetchWithRetries', wrapFetchWithRetries)
  }
  wrapAPIPromise(exports.APIPromise.prototype)

  return exports
})
