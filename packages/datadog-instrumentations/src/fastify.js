'use strict'

const methods = require('methods').concat('all')
const shimmer = require('../../datadog-shimmer')
const { addHook, channel, AsyncResource } = require('./helpers/instrument')

const errorChannel = channel('apm:fastify:middleware:error')
const handleChannel = channel('apm:fastify:request:handle')

const requestResources = new WeakMap()

function wrapFastify (fastify, contextTracking) {
  if (typeof fastify !== 'function') return fastify

  return function fastifyWithTrace () {
    const app = fastify.apply(this, arguments)

    if (!app) return app

    if (typeof app.addHook === 'function') {
      if (contextTracking) {
        app.addHook('onRequest', trackContext)
      }

      app.addHook('onRequest', onRequest)
      app.addHook('preHandler', preHandler)
      app.addHook = wrapAddHook(app.addHook, contextTracking)
    }

    methods.forEach(method => {
      app[method] = wrapMethod(app[method], contextTracking)
    })

    app.route = wrapRoute(app.route, contextTracking)

    return app
  }
}

function wrapAddHook (addHook, contextTracking) {
  return function addHookWithTrace (name, fn) {
    fn = arguments[arguments.length - 1]

    if (typeof fn !== 'function') return addHook.apply(this, arguments)

    arguments[arguments.length - 1] = shimmer.wrap(fn, function (request, reply, done) {
      const req = getReq(request)

      if (!req) return fn.apply(this, arguments)

      done = AsyncResource.bind(arguments[arguments.length - 1])

      try {
        if (typeof done === 'function') {
          arguments[arguments.length - 1] = function (err) {
            errorChannel.publish(err)
            return done.apply(this, arguments)
          }

          return AsyncResource.bind(fn).apply(this, arguments)
        } else {
          const promise = AsyncResource.bind(fn).apply(this, arguments)

          if (promise && typeof promise.catch === 'function') {
            return promise.catch(err => {
              errorChannel.publish(err)
              throw err
            })
          }

          return promise
        }
      } catch (e) {
        errorChannel.publish(e)
        throw e
      }
    })

    return addHook.apply(this, arguments)
  }
}

function onRequest (request, reply, next) {
  if (typeof next !== 'function') return

  const req = getReq(request)
  const res = getRes(reply)

  handleChannel.publish({ req, res })

  return next()
}

function preHandler (request, reply, next) {
  if (typeof next !== 'function') return
  if (!reply || typeof reply.send !== 'function') return next()

  reply.send = wrapSend(reply.send)

  next()
}

function trackContext (request, reply, next) {
  const req = getReq(request)

  requestResources.set(req, new AsyncResource('bound-anonymous-fn'))

  return next()
}

function wrapSend (send) {
  return function sendWithTrace (payload) {
    if (payload instanceof Error) {
      errorChannel.publish(payload)
    }

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

function wrapMethod (method, contextTracking) {
  if (typeof method !== 'function') return method

  return function methodWithTrace (url, opts, handler) {
    const lastIndex = arguments.length - 1

    handler = arguments[lastIndex]

    if (typeof handler === 'function') {
      arguments[lastIndex] = wrapHandler(handler, contextTracking)
    } else if (handler) {
      arguments[lastIndex].handler = wrapHandler(handler.handler, contextTracking)
    }

    return method.apply(this, arguments)
  }
}

function wrapHandler (handler, contextTracking) {
  if (!handler || typeof handler !== 'function' || handler.name === 'handlerWithTrace') {
    return handler
  }

  return function handlerWithTrace (request, reply) {
    if (contextTracking) {
      const req = getReq(request)

      return requestResources.get(req).runInAsyncScope(() => {
        return handler.apply(this, arguments)
      })
    } else {
      return handler.apply(this, arguments)
    }
  }
}

function getReq (request) {
  return request && (request.raw || request.req || request)
}

function getRes (reply) {
  return reply && (reply.raw || reply.res || reply)
}

addHook({ name: 'fastify', versions: ['>=3.25.2'] }, fastify => {
  const wrapped = shimmer.wrap(fastify, wrapFastify(fastify, false))

  wrapped.fastify = wrapped
  wrapped.default = wrapped

  return wrapped
})

addHook({ name: 'fastify', versions: ['3 - 3.25.1'] }, fastify => {
  const wrapped = shimmer.wrap(fastify, wrapFastify(fastify, true))

  wrapped.fastify = wrapped
  wrapped.default = wrapped

  return wrapped
})

addHook({ name: 'fastify', versions: ['1 - 2'] }, fastify => {
  return shimmer.wrap(fastify, wrapFastify(fastify, true))
})
