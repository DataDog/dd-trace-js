'use strict'

const methods = require('http').METHODS.map(m => m.toLowerCase()).concat('all')
const web = require('../../dd-trace/src/plugins/util/web')

function createWrapFastify (tracer, config) {
  config = web.normalizeConfig(config)

  return function wrapFastify (fastify) {
    if (typeof fastify !== 'function') return fastify

    return function fastifyWithTrace () {
      const app = fastify.apply(this, arguments)

      if (!app) return app

      if (typeof app.addHook === 'function') {
        app.addHook('onRequest', createOnRequest(tracer, config))
        app.addHook('preHandler', preHandler)
        app.addHook = createWrapAddHook(tracer, config)(app.addHook)
      }

      methods.forEach(method => {
        app[method] = wrapMethod(app[method])
      })

      app.route = wrapRoute(app.route)

      return app
    }
  }
}

function createWrapAddHook (tracer, config) {
  return function wrapAddHook (addHook) {
    return function addHookWithTrace (name, fn) {
      fn = arguments[arguments.length - 1]

      if (typeof fn !== 'function') return addHook.apply(this, arguments)

      arguments[arguments.length - 1] = safeWrap(fn, function (request, reply, done) {
        const req = getReq(request)

        if (!req) return fn.apply(this, arguments)

        done = arguments[arguments.length - 1]

        try {
          if (typeof done === 'function') {
            arguments[arguments.length - 1] = function (err) {
              web.addError(req, err)
              return done.apply(this, arguments)
            }

            return fn.apply(this, arguments)
          } else {
            const promise = fn.apply(this, arguments)

            if (promise && typeof promise.catch === 'function') {
              return promise.catch(err => {
                web.addError(req, err)
                throw err
              })
            }

            return promise
          }
        } catch (e) {
          web.addError(req, e)
          throw e
        }
      })

      return addHook.apply(this, arguments)
    }
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

    handler = arguments[lastIndex]

    if (typeof handler === 'function') {
      arguments[lastIndex] = wrapHandler(handler)
    } else if (handler) {
      arguments[lastIndex].handler = wrapHandler(handler.handler)
    }

    return method.apply(this, arguments)
  }
}

function wrapHandler (handler) {
  if (!handler || typeof handler !== 'function' || handler.name === 'handlerWithTrace') {
    return handler
  }

  return function handlerWithTrace (request, reply) {
    const req = getReq(request)

    return web.reactivate(req, () => handler.apply(this, arguments))
  }
}

// TODO: move this to a common util
function safeWrap (fn, wrapper) {
  Object.defineProperty(wrapper, 'length', Object.getOwnPropertyDescriptor(fn, 'length'))

  return wrapper
}

function getReq (request) {
  return request && (request.raw || request.req || request)
}

function getRes (reply) {
  return reply && (reply.raw || reply.res || reply)
}

module.exports = [
  {
    name: 'fastify',
    versions: ['>=1'],
    patch (fastify, tracer, config) {
      // `fastify` is a function so we return a wrapper that will replace its export.
      return this.wrapExport(fastify, createWrapFastify(tracer, config)(fastify))
    },
    unpatch (fastify) {
      this.unwrapExport(fastify)
    }
  }
]
