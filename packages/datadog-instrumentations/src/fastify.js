'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel } = require('./helpers/instrument')

const errorChannel = channel('apm:fastify:middleware:error')
const handleChannel = channel('apm:fastify:request:handle')
const routeAddedChannel = channel('apm:fastify:route:added')
const bodyParserReadCh = channel('datadog:fastify:body-parser:finish')
const queryParamsReadCh = channel('datadog:fastify:query-params:finish')
const cookieParserReadCh = channel('datadog:fastify-cookie:read:finish')
const responsePayloadReadCh = channel('datadog:fastify:response:finish')
const pathParamsReadCh = channel('datadog:fastify:path-params:finish')
const finishSetHeaderCh = channel('datadog:fastify:set-header:finish')

// context management channels
const preParsingCh = channel('datadog:fastify:pre-parsing:start')
const preValidationCh = channel('datadog:fastify:pre-validation:start')
const callbackFinishCh = channel('datadog:fastify:callback:execute')

const parsingContexts = new WeakMap()
const cookiesPublished = new WeakSet()
const bodyPublished = new WeakSet()

function wrapFastify (fastify, hasParsingEvents) {
  if (typeof fastify !== 'function') return fastify

  return function fastifyWithTrace (...args) {
    const app = fastify.apply(this, args)

    if (!app || typeof app.addHook !== 'function') return app

    app.addHook('onRoute', onRoute)
    app.addHook('onRequest', onRequest)
    app.addHook('preHandler', preHandler)

    if (hasParsingEvents) {
      app.addHook('preParsing', preParsing)
      app.addHook('preValidation', preValidation)
    } else {
      app.addHook('onRequest', preParsing)
      app.addHook('preHandler', preValidation)
    }

    app.addHook = wrapAddHook(app.addHook)

    return app
  }
}

function wrapAddHook (addHook) {
  return shimmer.wrapFunction(addHook, addHook => function addHookWithTrace (name, fn) {
    fn = arguments[arguments.length - 1]

    if (typeof fn !== 'function') return addHook.apply(this, arguments)

    arguments[arguments.length - 1] = shimmer.wrapFunction(fn, fn => function wrappedHook (...args) {
      // Fast path: every fastify request invokes each addHook'd handler, so the wrap
      // runs in the user's hot path. The only side effects this wrapper carries are
      // the three channels below; when none of them have a subscriber (the default
      // plugin config, and the steady state once appsec / cookie subscribers detach),
      // the wrap has nothing to do, and a `fn.apply(this, arguments)` forward keeps
      // V8's CallApplyArguments fast path intact.
      //
      // The previous shape mutated `arguments[arguments.length - 1]` to swap `done`.
      // That mutation materialises the magical arguments object and disables V8
      // inlining of the enclosing function. The slow path below builds a fresh args
      // array instead so the hot fast path keeps a clean forward.
      if (errorChannel.hasSubscribers || cookieParserReadCh.hasSubscribers || callbackFinishCh.hasSubscribers) {
        return invokeHookWithContext(name, fn, this, args)
      }
      return fn.apply(this, args)
    })

    return addHook.apply(this, arguments)
  })
}

/**
 * Slow path of {@link wrapAddHook}; entered only when at least one wrap-fed
 * channel has a subscriber. Allocates the per-request context, rewraps `done`,
 * and forwards to the user-supplied hook.
 *
 * @param {string} name Lifecycle phase the hook was registered against.
 * @param {Function} fn User-supplied hook.
 * @param {unknown} thisArg `this` Fastify passes to the hook.
 * @param {ArrayLike<unknown>} args Fastify's positional args; the dispatcher always
 *   places `done` as the trailing positional (see fastify/lib/hooks.js hookIterator,
 *   onSendHookRunner, preParsingHookRunner, onRequestAbortHookRunner).
 */
function invokeHookWithContext (name, fn, thisArg, args) {
  const request = args[0]
  const reply = args[1]
  const req = getReq(request)
  const ctx = { req }

  try {
    const lastArg = args.at(-1)

    if (typeof lastArg === 'function') {
      // Copy the args so we can swap the trailing `done` without touching the
      // caller's magical arguments object. Fastify hook arities are 2 to 4
      // across lifecycle phases, but `done` is always last.
      const callArgs = [...args]
      callArgs[callArgs.length - 1] = wrapHookDone(ctx, request, reply, req, name, lastArg)
      return fn.apply(thisArg, callArgs)
    }

    const promise = fn.apply(thisArg, args)

    if (promise && typeof promise.catch === 'function') {
      return promise.catch(error => {
        ctx.error = error
        return publishError(ctx)
      })
    }

    return promise
  } catch (error) {
    ctx.error = error
    throw publishError(ctx)
  }
}

/**
 * Per-request closure invoked when fastify resolves the user hook's `done`.
 * Captures `ctx` plus the dispatcher-level fields needed to publish on the
 * cookie / callback channels. The closure cannot be hoisted: fastify invokes
 * `done` with a single `(err)` arg, so request / reply / req / name / doneCallback
 * must close over rather than ride the call signature.
 *
 * @param {{ req: unknown, [key: string]: unknown }} ctx
 * @param {{ cookies?: Record<string, unknown>, [key: string]: unknown }} request
 * @param {object} reply
 * @param {unknown} req
 * @param {string} name
 * @param {Function} doneCallback
 */
function wrapHookDone (ctx, request, reply, req, name, doneCallback) {
  return function wrappedDone (error) {
    ctx.error = error
    publishError(ctx)

    const hasCookies = request.cookies && Object.keys(request.cookies).length > 0

    if (cookieParserReadCh.hasSubscribers && hasCookies && !cookiesPublished.has(req)) {
      ctx.res = getRes(reply)
      ctx.abortController = new AbortController()
      ctx.cookies = request.cookies

      cookieParserReadCh.publish(ctx)
      cookiesPublished.add(req)

      if (ctx.abortController.signal.aborted) return
    }

    if (name === 'onRequest' || name === 'preParsing') {
      parsingContexts.set(req, ctx)

      if (callbackFinishCh.hasSubscribers) {
        const self = this
        const allArgs = arguments
        return callbackFinishCh.runStores(ctx, () => doneCallback.apply(self, allArgs))
      }
    }
    return doneCallback.apply(this, arguments)
  }
}

function onRequest (request, reply, done) {
  if (typeof done !== 'function') return

  const req = getReq(request)
  const res = getRes(reply)
  const routeConfig = getRouteConfig(request)

  const ctx = { req, res, routeConfig }
  handleChannel.publish(ctx)

  return done()
}

function preHandler (request, reply, done) {
  if (typeof done !== 'function') return
  if (!reply || typeof reply.send !== 'function') return done()

  const req = getReq(request)
  const res = getRes(reply)
  const ctx = { req, res }

  const hasBody = request.body && Object.keys(request.body).length > 0

  // For multipart/form-data, the body is not available until after preValidation hook
  if (bodyParserReadCh.hasSubscribers && hasBody && !bodyPublished.has(req)) {
    ctx.abortController = new AbortController()
    ctx.body = request.body
    bodyParserReadCh.publish(ctx)
    bodyPublished.add(req)

    if (ctx.abortController.signal.aborted) return
  }

  reply.send = wrapSend(reply.send, req)

  done()
}

function preValidation (request, reply, done) {
  const req = getReq(request)
  const ctx = parsingContexts.get(req)

  // No stored context means the onRequest/preParsing fast path ran (no error /
  // cookie / callback subscribers), so there is nothing to publish on; forward
  // `done` instead of dereferencing a missing ctx in processInContext.
  if (!ctx) return done()

  ctx.res = getRes(reply)

  preValidationCh.runStores(ctx, processInContext, undefined, request, ctx, done, req)
}

/**
 * @param {{ query?: object, body?: object, params?: object, [key: string]: unknown }} request
 * @param {{ res?: object, abortController?: AbortController, [key: string]: unknown }} ctx
 * @param {Function} done
 * @param {unknown} req
 */
function processInContext (request, ctx, done, req) {
  let abortController

  if (queryParamsReadCh.hasSubscribers && request.query) {
    abortController ??= new AbortController()
    ctx.abortController = abortController
    ctx.query = request.query
    queryParamsReadCh.publish(ctx)

    if (abortController.signal.aborted) return
  }

  // Analyze body before schema validation
  if (bodyParserReadCh.hasSubscribers && request.body && !bodyPublished.has(req)) {
    abortController ??= new AbortController()
    ctx.abortController = abortController
    ctx.body = request.body
    bodyParserReadCh.publish(ctx)

    bodyPublished.add(req)

    if (abortController.signal.aborted) return
  }

  if (pathParamsReadCh.hasSubscribers && request.params) {
    abortController ??= new AbortController()
    ctx.abortController = abortController
    ctx.params = request.params
    pathParamsReadCh.publish(ctx)

    if (abortController.signal.aborted) return
  }

  done()
}

function preParsing (request, reply, payload, done) {
  if (typeof done !== 'function') {
    done = payload
  }

  const req = getReq(request)
  const ctx = { req }

  parsingContexts.set(req, ctx)

  preParsingCh.runStores(ctx, () => done())
}

function wrapSend (send, req) {
  return function sendWithTrace (payload) {
    const ctx = { req }
    if (payload instanceof Error) {
      ctx.error = payload
      publishError(ctx)
    } else if (canPublishResponsePayload(payload)) {
      const res = getRes(this)
      ctx.res = res
      ctx.body = payload
      responsePayloadReadCh.publish(ctx)
    }

    return send.apply(this, arguments)
  }
}

function getReq (request) {
  return request && (request.raw || request.req || request)
}

function getRes (reply) {
  return reply && (reply.raw || reply.res || reply)
}

function getRouteConfig (request) {
  return request?.routeOptions?.config
}

let publishingError = false

function publishError (ctx) {
  // `errorChannel` is public: a subscriber that re-enters the hook pipeline while
  // handling the error republishes here and recurses until the stack overflows.
  if (ctx.error && !publishingError) {
    publishingError = true
    try {
      errorChannel.publish(ctx)
    } finally {
      publishingError = false
    }
  }

  return ctx.error
}

function onRoute (routeOptions) {
  const ctx = { routeOptions, onRoute }
  routeAddedChannel.publish(ctx)
}

// send() payload types: https://fastify.dev/docs/latest/Reference/Reply/#senddata
function canPublishResponsePayload (payload) {
  return responsePayloadReadCh.hasSubscribers &&
    payload &&
    typeof payload === 'object' &&
    typeof payload.pipe !== 'function' && // Node streams
    typeof payload.body?.pipe !== 'function' && // Response with body stream
    !Buffer.isBuffer(payload) && // Buffer
    !(payload instanceof ArrayBuffer) && // ArrayBuffer
    !ArrayBuffer.isView(payload) // TypedArray
}

addHook({ name: 'fastify', versions: ['>=3'] }, (fastify) => {
  const wrapped = shimmer.wrapFunction(fastify, fastify => wrapFastify(fastify, true))

  wrapped.fastify = wrapped
  wrapped.default = wrapped

  return wrapped
})

addHook({ name: 'fastify', versions: ['2'] }, (fastify) => {
  return shimmer.wrapFunction(fastify, fastify => wrapFastify(fastify, true))
})

addHook({ name: 'fastify', versions: ['1'] }, (fastify) => {
  return shimmer.wrapFunction(fastify, fastify => wrapFastify(fastify, false))
})

function wrapReplyHeader (Reply) {
  shimmer.wrap(Reply.prototype, 'header', header => function (key, value) {
    const result = header.apply(this, arguments)

    if (finishSetHeaderCh.hasSubscribers && key && value) {
      const ctx = { name: key, value, res: getRes(this) }
      finishSetHeaderCh.publish(ctx)
    }

    return result
  })

  return Reply
}

addHook({ name: 'fastify', file: 'lib/reply.js', versions: ['>=1'] }, wrapReplyHeader)
