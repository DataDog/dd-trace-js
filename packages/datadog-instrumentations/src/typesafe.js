'use strict'

const { tracingChannel } = require('dc-polyfill')

const systemOneChannel = tracingChannel('orchestrion:@typesafe-ai/sdk:TypeSafeClient_systemOne')
const apiPromiseChannel = tracingChannel('orchestrion:@typesafe-ai/sdk:APIPromise_constructor')

// `systemOne` builds its one `APIPromise` synchronously, between its start and end events. The plugins subscribe to
// `asyncEnd`, which only this file publishes, so it tells whether they are enabled.
let pendingCtx

systemOneChannel.start.subscribe(ctx => {
  if (systemOneChannel.asyncEnd.hasSubscribers) pendingCtx = ctx
})

systemOneChannel.end.subscribe(ctx => {
  if (pendingCtx === ctx) pendingCtx = undefined
  if (!systemOneChannel.asyncEnd.hasSubscribers) return

  // Copied like the SDK copies it, since the caller may change the object for its next call before this one finishes
  const request = ctx.arguments[0]
  if (request && typeof request === 'object') ctx.request = { ...request }

  // No `APIPromise` was built (e.g. `systemOne` threw), so no response will finish the span
  if (!ctx.observed) finish(ctx)
})

// Every `APIPromise` method (awaiting, `asResponse()`, `withResponse()`, `map()`) reads the response promise passed to
// the constructor, so observing it covers each of them, and calls that are never awaited. Promises built outside
// `systemOne`, such as the one `map()` returns, are left alone.
apiPromiseChannel.start.subscribe(ctx => {
  const systemOneCtx = pendingCtx
  const responsePromise = ctx.arguments[0]
  if (!systemOneCtx || typeof responsePromise?.then !== 'function') return
  pendingCtx = undefined
  systemOneCtx.observed = true

  ctx.arguments[0] = responsePromise.then(response => {
    readResponse(systemOneCtx, response)
    return response
  }, error => {
    finish(systemOneCtx, undefined, error)
    throw error
  })
})

/**
 * Reads the body from a clone so the caller's response stays unread.
 *
 * @param {object} ctx
 * @param {Response} response
 */
function readResponse (ctx, response) {
  try {
    response.clone().text().then(body => {
      ctx.responseText = body
      finish(ctx, parseBody(body))
    }, error => finish(ctx, undefined, error))
  } catch (error) {
    finish(ctx, undefined, error)
  }
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
    systemOneChannel.error.publish(ctx)
  }

  ctx.result = result
  systemOneChannel.asyncEnd.publish(ctx)
}
