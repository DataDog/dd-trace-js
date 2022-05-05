'use strict'

const methods = require('methods').concat('all')
const shimmer = require('../../datadog-shimmer')
const { addHook, channel, AsyncResource } = require('./helpers/instrument')

const errorChannel = channel('apm:fastify:middleware:error')
const handleChannel = channel('apm:fastify:request:handle')

const requestResources = new WeakMap()

function wrapFastify (fastify) {
  if (typeof fastify !== 'function') return fastify

  return function fastifyWithTrace () {
    const app = fastify.apply(this, arguments)

    if (!app) return app

    if (typeof app.addHook === 'function') {
      app.addHook('onRequest', onRequest)
      app.addHook = wrapAddHook(app.addHook)
      app.addHook('preHandler', preHandler)
    }

    methods.forEach(method => {
      app[method] = wrapMethod(app[method])
    })

    app.route = wrapRoute(app.route)

    return app
  }
}

function wrapAddHook (addHook) {
  return function addHookWithTrace (name, fn) {
    fn = arguments[arguments.length - 1]

    if (typeof fn !== 'function') return addHook.apply(this, arguments)

    arguments[arguments.length - 1] = shimmer.wrap(fn, function (request, reply, done) {
      const req = getReq(request)
      const requestResource = requestResources.get(req)

      if (!requestResource) return fn.apply(this, arguments)

      requestResource.runInAsyncScope(() => {
        const hookResource = new AsyncResource('bound-anonymous-fn')

        try {
          if (typeof done === 'function') {
            done = arguments[arguments.length - 1]

            arguments[arguments.length - 1] = hookResource.bind(function (err) {
              errorChannel.publish(err)
              return done.apply(this, arguments)
            })

            return hookResource.bind(fn).apply(this, arguments)
          } else {
            const promise = hookResource.bind(fn).apply(this, arguments)

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
    })

    return addHook.apply(this, arguments)
  }
}

function onRequest (request, reply, next) {
  if (typeof next !== 'function') return

  const req = getReq(request)
  const res = getRes(reply)

  requestResources.set(req, new AsyncResource('bound-anonymous-fn'))
  handleChannel.publish({ req, res })

  return next()
}

function preHandler (request, reply, next) {
  if (typeof next !== 'function') return
  if (!reply || typeof reply.send !== 'function') return next()

  const req = getReq(request)

  reply.send = requestResources.get(req).bind(wrapSend(reply.send))

  next()
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

    return requestResources.get(req).runInAsyncScope(() => {
      return handler.apply(this, arguments)
    })
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
