'use strict'

const methods = require('methods').concat('all')
const web = require('../../dd-trace/src/plugins/util/web')

function createWrapFastify (tracer, config) {
  config = web.normalizeConfig(config)

  return function wrapFastify (fastify) {
    if (typeof fastify !== 'function') return fastify

    const fastifyWithTrace = function fastifyWithTrace () {
      return fastify._datadog_wrapper.apply(this, arguments)
    }

    fastify._datadog_wrapper = function () {
      const app = fastify.apply(this, arguments)

      if (!app) return app

      if (typeof app.addHook === 'function') {
        app.addHook('onRequest', createOnRequest(tracer, config))
        app.addHook('preHandler', preHandler)
      }

      methods.forEach(method => {
        app[method] = wrapMethod(app[method])
      })

      app.route = wrapRoute(app.route)

      return app
    }

    return fastifyWithTrace
  }
}

function createOnRequest (tracer, config) {
  return function onRequest (request, reply, next) {
    if (typeof next !== 'function') return

    const req = getReq(request)
    const res = getRes(reply)
    const name = 'fastify.request'

    return web.instrument(tracer, config, req, res, name, () => next())
  }
}

function preHandler (request, reply, next) {
  if (typeof next !== 'function') return
  if (!reply || typeof reply.send !== 'function') return next()

  reply.send = wrapSend(reply.send)

  next()
}

function wrapSend (send) {
  return function sendWithTrace (payload) {
    const req = getReq(this && this.request)

    web.addError(req, payload)

    return send.apply(this, arguments)
  }
}

function wrapRoute (route) {
  if (typeof route !== 'function') return route

  return function routeWithTrace (opts) {
    opts.handler = wrapHandler(opts.handler)

    return route.apply(this, arguments)
  }
}

function wrapMethod (method) {
  if (typeof method !== 'function') return method

  return function methodWithTrace (url, opts, handler) {
    const lastIndex = arguments.length - 1

    arguments[lastIndex] = wrapHandler(arguments[lastIndex])

    return method.apply(this, arguments)
  }
}

function wrapHandler (handler) {
  return function handlerWithTrace (request, reply) {
    const req = getReq(request)

    return web.reactivate(req, () => handler.apply(this, arguments))
  }
}

function unwrapFastify (fastify) {
  fastify._datadog_wrapper = fastify
}

function getReq (request) {
  return request && (request.req || request)
}

function getRes (reply) {
  return reply && (reply.res || reply)
}

module.exports = [
  {
    name: 'fastify',
    versions: ['>=1'],
    patch (fastify, tracer, config) {
      // `fastify` is a function so we return a wrapper that will replace its export.
      return createWrapFastify(tracer, config)(fastify)
    },
    unpatch (fastify) {
      unwrapFastify(fastify)
    }
  }
]
