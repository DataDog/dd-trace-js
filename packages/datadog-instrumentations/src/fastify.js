'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel, AsyncResource } = require('./helpers/instrument')

const errorChannel = channel('apm:fastify:middleware:error')
const handleChannel = channel('apm:fastify:request:handle')
const routeAddedChannel = channel('apm:fastify:route:added')
const bodyParserReadCh = channel('datadog:fastify:body-parser:finish')
const queryParamsReadCh = channel('datadog:fastify:query-params:finish')
const cookieParserReadCh = channel('datadog:fastify-cookie:read:finish')
const responsePayloadReadCh = channel('datadog:fastify:response:finish')
const pathParamsReadCh = channel('datadog:fastify:path-params:finish')
const finishSetHeaderCh = channel('datadog:fastify:set-header:finish')

const parsingResources = new WeakMap()
const cookiesPublished = new WeakSet()
const bodyPublished = new WeakSet()

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

      try {
        // done callback is always the last argument
        const doneCallback = arguments[arguments.length - 1]

        if (typeof doneCallback === 'function') {
          arguments[arguments.length - 1] = function (err) {
            publishError(err, req)

            const hasCookies = request.cookies && Object.keys(request.cookies).length > 0

            if (cookieParserReadCh.hasSubscribers && hasCookies && !cookiesPublished.has(req)) {
              const res = getRes(reply)
              const abortController = new AbortController()

              cookieParserReadCh.publish({
                req,
                res,
                abortController,
                cookies: request.cookies
              })

              cookiesPublished.add(req)

              if (abortController.signal.aborted) return
            }

            if (name === 'onRequest' || name === 'preParsing') {
              const parsingResource = new AsyncResource('bound-anonymous-fn')

              parsingResources.set(req, parsingResource)

              return parsingResource.runInAsyncScope(() => {
                return doneCallback.apply(this, arguments)
              })
            }
            return doneCallback.apply(this, arguments)
          }

          return fn.apply(this, arguments)
        }

        const promise = fn.apply(this, arguments)

        if (promise && typeof promise.catch === 'function') {
          return promise.catch(err => publishError(err, req))
        }

        return promise
      } catch (e) {
        throw publishError(e, req)
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

  handleChannel.publish({ req, res, routeConfig })

  return done()
}

function preHandler (request, reply, done) {
  if (typeof done !== 'function') return
  if (!reply || typeof reply.send !== 'function') return done()

  const req = getReq(request)
  const res = getRes(reply)

  const hasBody = request.body && Object.keys(request.body).length > 0

  // For multipart/form-data, the body is not available until after preValidation hook
  if (bodyParserReadCh.hasSubscribers && hasBody && !bodyPublished.has(req)) {
    const abortController = new AbortController()

    bodyParserReadCh.publish({ req, res, body: request.body, abortController })

    bodyPublished.add(req)

    if (abortController.signal.aborted) return
  }

  reply.send = wrapSend(reply.send, req)

  done()
}

function preValidation (request, reply, done) {
  const req = getReq(request)
  const res = getRes(reply)
  const parsingResource = parsingResources.get(req)

  const processInContext = () => {
    let abortController

    if (queryParamsReadCh.hasSubscribers && request.query) {
      abortController ??= new AbortController()

      queryParamsReadCh.publish({
        req,
        res,
        abortController,
        query: request.query
      })

      if (abortController.signal.aborted) return
    }

    // Analyze body before schema validation
    if (bodyParserReadCh.hasSubscribers && request.body && !bodyPublished.has(req)) {
      abortController ??= new AbortController()

      bodyParserReadCh.publish({ req, res, body: request.body, abortController })

      bodyPublished.add(req)

      if (abortController.signal.aborted) return
    }

    if (pathParamsReadCh.hasSubscribers && request.params) {
      abortController ??= new AbortController()

      pathParamsReadCh.publish({
        req,
        res,
        abortController,
        params: request.params
      })

      if (abortController.signal.aborted) return
    }

    done()
  }

  if (!parsingResource) return processInContext()

  parsingResource.runInAsyncScope(processInContext)
}

function preParsing (request, reply, payload, done) {
  if (typeof done !== 'function') {
    done = payload
  }

  const req = getReq(request)
  const parsingResource = new AsyncResource('bound-anonymous-fn')

  parsingResources.set(req, parsingResource)
  parsingResource.runInAsyncScope(() => done())
}

function wrapSend (send, req) {
  return function sendWithTrace (payload) {
    if (payload instanceof Error) {
      errorChannel.publish({ req, error: payload })
    } else if (canPublishResponsePayload(payload)) {
      const res = getRes(this)
      responsePayloadReadCh.publish({ req, res, body: payload })
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

function publishError (error, req) {
  if (error) {
    errorChannel.publish({ error, req })
  }

  return error
}

function onRoute (routeOptions) {
  routeAddedChannel.publish({ routeOptions, onRoute })
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

function wrapReplyHeader (Reply) {
  shimmer.wrap(Reply.prototype, 'header', header => function (key, value) {
    const result = header.apply(this, arguments)

    if (finishSetHeaderCh.hasSubscribers && key && value) {
      finishSetHeaderCh.publish({ name: key, value, res: getRes(this) })
    }

    return result
  })

  return Reply
}

addHook({ name: 'fastify', file: 'lib/reply.js', versions: ['1', '2', '>=3'] }, wrapReplyHeader)
