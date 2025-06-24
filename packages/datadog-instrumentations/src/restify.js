'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel } = require('./helpers/instrument')
const handlers = ['use', 'pre']
const methods = ['del', 'get', 'head', 'opts', 'post', 'put', 'patch']

const handleChannel = channel('apm:restify:request:handle')
const errorChannel = channel('apm:restify:middleware:error')
const enterChannel = channel('apm:restify:middleware:enter')
const exitChannel = channel('apm:restify:middleware:exit')
const finishChannel = channel('apm:restify:middleware:finish')
const nextChannel = channel('apm:restify:middleware:next')

function wrapSetupRequest (setupRequest) {
  return function (req, res) {
    handleChannel.publish({ req, res })
    return setupRequest.apply(this, arguments)
  }
}

function wrapMethod (method) {
  return function (path, ...middlewares) {
    const wrappedMiddlewares = middlewares.map(wrapFn)

    return method.apply(this, [path, ...wrappedMiddlewares])
  }
}

function wrapHandler (method) {
  return function (...middlewares) {
    return method.apply(this, middlewares.map(wrapFn))
  }
}

function wrapFn (fn) {
  if (Array.isArray(fn)) return fn.map(wrapFn)

  return shimmer.wrapFunction(fn, fn => function (req, res, next) {
    if (typeof next === 'function') {
      arguments[2] = wrapNext(req, next)
    }

    const route = req.route && req.route.path

    enterChannel.publish({ req, route })

    try {
      const result = fn.apply(this, arguments)
      if (typeof result?.then === 'function') {
        return result.then(function (result) {
          nextChannel.publish({ req })
          finishChannel.publish({ req })
          return result
        }).catch(function (error) {
          errorChannel.publish({ req, error })
          nextChannel.publish({ req })
          finishChannel.publish({ req })
          throw error
        })
      }
      return result
    } catch (error) {
      errorChannel.publish({ req, error })
      nextChannel.publish({ req })
      finishChannel.publish({ req })
      throw error
    } finally {
      exitChannel.publish({ req })
    }
  })
}

function wrapNext (req, next) {
  return shimmer.wrapFunction(next, next => function () {
    nextChannel.publish({ req })
    finishChannel.publish({ req })

    next.apply(this, arguments)
  })
}

addHook({ name: 'restify', versions: ['>=3'], file: 'lib/server.js' }, Server => {
  shimmer.wrap(Server.prototype, '_setupRequest', wrapSetupRequest)
  shimmer.massWrap(Server.prototype, handlers, wrapHandler)
  shimmer.massWrap(Server.prototype, methods, wrapMethod)

  return Server
})
