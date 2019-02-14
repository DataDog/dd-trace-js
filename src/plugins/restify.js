'use strict'

const web = require('./util/web')
const handlers = ['use', 'pre']
const methods = ['del', 'get', 'head', 'opts', 'post', 'put', 'patch']

function createWrapSetupRequest (tracer, config) {
  config = web.normalizeConfig(config)

  return function wrapSetupRequest (setupRequest) {
    return function setupRequestWithTrace (req, res) {
      return web.instrument(tracer, config, req, res, 'restify.request', () => {
        web.beforeEnd(req, () => {
          if (req.route) {
            web.enterRoute(req, req.route.path)
          }
        })

        return setupRequest.apply(this, arguments)
      })
    }
  }
}

function createWrapMethod (tracer, config) {
  return function wrapMethod (method) {
    return function methodWithTrace (path) {
      const middleware = wrapMiddleware(Array.prototype.slice.call(arguments, 1))

      return method.apply(this, [path].concat(middleware))
    }
  }
}

function createWrapHandler (tracer, config) {
  return function wrapMethod (method) {
    return function methodWithTrace () {
      return method.apply(this, wrapMiddleware(arguments))
    }
  }
}

function wrapMiddleware (middleware) {
  return Array.prototype.map.call(middleware, wrapFn)
}

function wrapFn (fn) {
  return function (req, res, next) {
    return web.reactivate(req, () => fn.apply(this, arguments))
  }
}

module.exports = [
  {
    name: 'restify',
    versions: ['>=3'],
    file: 'lib/server.js',
    patch (Server, tracer, config) {
      this.wrap(Server.prototype, '_setupRequest', createWrapSetupRequest(tracer, config))
      this.wrap(Server.prototype, handlers, createWrapHandler(tracer, config))
      this.wrap(Server.prototype, methods, createWrapMethod(tracer, config))
    },
    unpatch (Server) {
      this.unwrap(Server.prototype, '_setupRequest')
      this.unwrap(Server.prototype, handlers)
      this.unwrap(Server.prototype, methods)
    }
  }
]
