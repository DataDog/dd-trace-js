'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel, createErrorPublisher } = require('./helpers/instrument')
const methods = ['del', 'get', 'head', 'opts', 'post', 'put', 'patch']

const handleChannel = channel('apm:restify:request:handle')
const errorChannel = channel('apm:restify:middleware:error')
const enterChannel = channel('apm:restify:middleware:enter')
const exitChannel = channel('apm:restify:middleware:exit')
const finishChannel = channel('apm:restify:middleware:finish')
const nextChannel = channel('apm:restify:middleware:next')
const publishError = createErrorPublisher(errorChannel)

function wrapSetupRequest (setupRequest) {
  return function (req, res) {
    handleChannel.publish({ req, res })
    return setupRequest.apply(this, arguments)
  }
}

function wrapMethod (method) {
  return function (path, ...middlewares) {
    const wrappedMiddlewares = wrapFn(middlewares, true)

    return method.apply(this, [path, ...wrappedMiddlewares])
  }
}

function wrapHandler (method, afterLookup) {
  return function (...middlewares) {
    return method.apply(this, wrapFn(middlewares, afterLookup))
  }
}

function wrapFn (fn, afterLookup) {
  if (Array.isArray(fn)) return fn.map(middleware => wrapFn(middleware, afterLookup))

  return shimmer.wrapFunction(fn, fn => function (req, res, next) {
    if (typeof next === 'function') {
      arguments[2] = wrapNext(req, next)
    }

    const matchedRoute = afterLookup ? req.route : undefined
    const route = matchedRoute && matchedRoute.path

    enterChannel.publish({ req, route, routeSelected: !!matchedRoute })

    try {
      const result = fn.apply(this, arguments)
      if (typeof result?.then === 'function') {
        return result.then(function (result) {
          nextChannel.publish({ req })
          finishChannel.publish({ req })
          return result
        }).catch(function (error) {
          publishError({ req, error })
          nextChannel.publish({ req })
          finishChannel.publish({ req })
          throw error
        })
      }
      return result
    } catch (error) {
      publishError({ req, error })
      nextChannel.publish({ req })
      finishChannel.publish({ req })
      throw error
    } finally {
      exitChannel.publish({ req })
    }
  })
}

function wrapNext (req, next) {
  return shimmer.wrapFunction(next, next => function (...args) {
    nextChannel.publish({ req })
    finishChannel.publish({ req })

    next.apply(this, args)
  })
}

addHook({ name: 'restify', versions: ['>=3'], file: 'lib/server.js' }, Server => {
  shimmer.wrap(Server.prototype, '_setupRequest', wrapSetupRequest)
  shimmer.wrap(Server.prototype, 'pre', method => wrapHandler(method, false))
  shimmer.wrap(Server.prototype, 'use', method => wrapHandler(method, true))
  shimmer.massWrap(Server.prototype, methods, wrapMethod)

  return Server
})
