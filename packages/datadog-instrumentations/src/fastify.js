'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel } = require('./helpers/instrument')

const errorChannel = channel('apm:fastify:middleware:error')
const handleChannel = channel('apm:fastify:request:handle')
const routeAddedChannel = channel('apm:fastify:route:added')
const bodyParserReadCh = channel('datadog:fastify:body-parser:finish')
const queryParamsReadCh = channel('datadog:fastify:query-params:finish')
const responsePayloadReadCh = channel('datadog:fastify:response:finish')
const pathParamsReadCh = channel('datadog:fastify:path-params:finish')

// context management channels
const preParsingCh = channel('datadog:fastify:pre-parsing:start')
const preValidationCh = channel('datadog:fastify:pre-validation:start')
const addHookStartCh = channel('datadog:fastify:add-hook:start')
const addHookFinishCh = channel('datadog:fastify:add-hook:finish')

const parsingContexts = new WeakMap()

function wrapFastify (fastify, hasParsingEvents) {
  if (typeof fastify !== 'function') return fastify

  return function fastifyWithTrace () {
    const app = fastify.apply(this, arguments)

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

    arguments[arguments.length - 1] = shimmer.wrapFunction(fn, fn => function (request, reply, done) {
      const req = getReq(request)
      const ctx = { req }

      try {
        if (typeof done === 'function') {
          done = arguments[arguments.length - 1]

          arguments[arguments.length - 1] = addHookStartCh.runStores(ctx, () => {
            return function (err) {
              ctx.error = err
              publishError(ctx)

              if (name === 'onRequest' || name === 'preParsing') {
                parsingContexts.set(req, ctx)

                return addHookFinishCh.runStores(ctx, () => {
                  return done.apply(this, arguments)
                })
              }
              return done.apply(this, arguments)
            }
          })

          return fn.apply(this, arguments)
        }
        const promise = fn.apply(this, arguments)

        if (promise && typeof promise.catch === 'function') {
          return promise.catch(err => {
            ctx.error = err
            return publishError(ctx)
          })
        }

        return promise
      } catch (e) {
        ctx.error = e
        throw publishError(ctx)
      }
    })

    return addHook.apply(this, arguments)
  })
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

  reply.send = wrapSend(reply.send, req)

  done()
}

function preValidation (request, reply, done) {
  const req = getReq(request)
  const res = getRes(reply)
  const ctx = parsingContexts.get(req)
  ctx.res = res

  const processInContext = () => {
    let abortController

    if (queryParamsReadCh.hasSubscribers && request.query) {
      abortController ??= new AbortController()
      ctx.abortController = abortController
      ctx.query = request.query
      queryParamsReadCh.publish(ctx)

      if (abortController.signal.aborted) return
    }

    if (bodyParserReadCh.hasSubscribers && request.body) {
      abortController ??= new AbortController()
      ctx.abortController = abortController
      ctx.body = request.body
      bodyParserReadCh.publish(ctx)

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

  if (!ctx) return processInContext()

  preValidationCh.runStores(ctx, processInContext)
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
      errorChannel.publish(ctx)
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

function publishError (ctx) {
  if (ctx.error) {
    errorChannel.publish(ctx)
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

addHook({ name: 'fastify', versions: ['>=3'] }, fastify => {
  const wrapped = shimmer.wrapFunction(fastify, fastify => wrapFastify(fastify, true))

  wrapped.fastify = wrapped
  wrapped.default = wrapped

  return wrapped
})

addHook({ name: 'fastify', versions: ['2'] }, fastify => {
  return shimmer.wrapFunction(fastify, fastify => wrapFastify(fastify, true))
})

addHook({ name: 'fastify', versions: ['1'] }, fastify => {
  return shimmer.wrapFunction(fastify, fastify => wrapFastify(fastify, false))
})
