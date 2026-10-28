'use strict'

const { tracingChannel } = require('dc-polyfill')

const systemOneChannel = tracingChannel('orchestrion:@typesafe-ai/sdk:TypeSafeClient_systemOne')
const apiPromiseChannel = tracingChannel('orchestrion:@typesafe-ai/sdk:APIPromise_constructor')

const systemOneContexts = new WeakMap()

// `systemOne` returns its `APIPromise` without awaiting it, so the span finishes once the response arrives
systemOneChannel.end.subscribe(ctx => {
  if (!systemOneChannel.start.hasSubscribers) return

  // Copied like the SDK copies it, since the caller may change the object for its next call before this one finishes
  const request = ctx.arguments[0]
  if (request && typeof request === 'object') ctx.request = { ...request }

  if (!ctx.error && ctx.result && typeof ctx.result === 'object') {
    systemOneContexts.set(ctx.result, ctx)
  } else {
    finish(ctx)
  }
})

// Every `APIPromise` method (awaiting, `asResponse()`, `withResponse()`, `map()`) reads the response promise passed to
// the constructor, so observing it covers each of them, and calls that are never awaited.
apiPromiseChannel.start.subscribe(ctx => {
  const responsePromise = ctx.arguments[0]
  if (!systemOneChannel.start.hasSubscribers || typeof responsePromise?.then !== 'function') return

  ctx.arguments[0] = responsePromise.then(response => {
    const systemOneCtx = systemOneContexts.get(ctx.self)
    if (systemOneCtx) readResponse(systemOneCtx, response)
    return response
  }, error => {
    const systemOneCtx = systemOneContexts.get(ctx.self)
    if (systemOneCtx) finish(systemOneCtx, undefined, error)
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
    }, () => finish(ctx))
  } catch {
    finish(ctx)
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
