'use strict'

const web = require('../../dd-trace/src/plugins/util/web')

function createWrapFastify (tracer, config) {
  config = web.normalizeConfig(config)

  return function wrapFastify (fastify) {
    const fastifyWithTrace = function fastifyWithTrace () {
      return fastify._datadog_wrapper.apply(this, arguments)
    }

    fastify._datadog_wrapper = function () {
      const app = fastify.apply(this, arguments)

      app.addHook('onRequest', createOnRequest(tracer, config))
      app.addHook('preHandler', preHandler)

      return app
    }

    return fastifyWithTrace
  }
}

function createOnRequest (tracer, config) {
  return function onRequest (request, reply, next) {
    const req = getReq(request)
    const res = getRes(reply)
    const name = 'fastify.request'

    return web.instrument(tracer, config, req, res, name, () => next())
  }
}

function preHandler (request, reply, next) {
  reply.send = wrapSend(reply.send)

  next()
}

function wrapSend (send) {
  return function sendWithTrace (payload) {
    const req = getReq(this.request)

    web.addError(req, payload)

    return send.apply(this, arguments)
  }
}

function unwrapFastify (fastify) {
  fastify._datadog_wrapper = fastify
}

function getReq (request) {
  return request.req || request
}

function getRes (reply) {
  return reply.res || reply
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
