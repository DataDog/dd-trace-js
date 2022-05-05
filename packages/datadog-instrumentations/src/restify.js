'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const handlers = ['use', 'pre']
const methods = ['del', 'get', 'head', 'opts', 'post', 'put', 'patch']

const handleChannel = channel('apm:restify:request:handle')
const routeChannel = channel('apm:restify:request:route')

function wrapSetupRequest (setupRequest) {
  return function setupRequestWithTrace (req, res) {
    handleChannel.publish({ req, res })
    return setupRequest.apply(this, arguments)
  }
}

function wrapMethod (method) {
  return function methodWithTrace (path) {
    const middleware = wrapMiddleware(Array.prototype.slice.call(arguments, 1))

    return method.apply(this, [path].concat(middleware))
  }
}

function wrapHandler (method) {
  return function methodWithTrace () {
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
      arguments[2] = AsyncResource.bind(next)
    }

    if (req.route) {
      routeChannel.publish({ req, route: req.route })
    }

    return fn.apply(this, arguments)
  }
}

addHook({ name: 'restify', versions: ['>=3'], file: 'lib/server.js' }, Server => {
  shimmer.wrap(Server.prototype, '_setupRequest', wrapSetupRequest)
  shimmer.massWrap(Server.prototype, handlers, wrapHandler)
  shimmer.wrap(Server.prototype, methods, wrapMethod)

  return Server
})
