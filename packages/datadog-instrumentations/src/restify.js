'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel } = require('./helpers/instrument')
const handlers = ['use', 'pre']
const methods = ['del', 'get', 'head', 'opts', 'post', 'put', 'patch']

const handleChannel = channel('apm:restify:request:handle')
const errorChannel = channel('apm:restify:middleware:error')
const enterChannel = channel('apm:restify:middleware:enter')
const exitChannel = channel('apm:restify:middleware:exit')
const nextChannel = channel('apm:restify:middleware:next')

function wrapSetupRequest (setupRequest) {
  return function (req, res) {
    handleChannel.publish({ req, res })
    return setupRequest.apply(this, arguments)
  }
}

function wrapMethod (method) {
  return function (path) {
    const middleware = wrapMiddleware(Array.prototype.slice.call(arguments, 1))

    return method.apply(this, [path].concat(middleware))
  }
}

function wrapHandler (method) {
  return function () {
    return method.apply(this, wrapMiddleware(arguments))
  }
}

function wrapMiddleware (middleware) {
  return Array.prototype.map.call(middleware, wrapFn)
}

function wrapFn (fn) {
  if (Array.isArray(fn)) return wrapMiddleware(fn)

  return function (req, res, next) {
    if (typeof next === 'function') {
      arguments[2] = wrapNext(req, next)
    }

    const route = req.route && req.route.path

    enterChannel.publish({ req, route })

    try {
      return fn.apply(this, arguments)
    } catch (error) {
      errorChannel.publish({ req, error })
      nextChannel.publish({ req })
      exitChannel.publish({ req })
      throw error
    }
  }
}

function wrapNext (req, next) {
  return function () {
    nextChannel.publish({ req })
    exitChannel.publish({ req })

    next.apply(this, arguments)
  }
}

addHook({ name: 'restify', versions: ['>=3'], file: 'lib/server.js' }, Server => {
  shimmer.wrap(Server.prototype, '_setupRequest', wrapSetupRequest)
  shimmer.massWrap(Server.prototype, handlers, wrapHandler)
  shimmer.massWrap(Server.prototype, methods, wrapMethod)

  return Server
})
