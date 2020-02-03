'use strict'

const web = require('../../dd-trace/src/plugins/util/web')

function createWrapCallback (tracer, config) {
  config = web.normalizeConfig(config)

  return function wrapCallback (callback) {
    return function callbackWithTrace () {
      const handleRequest = callback.apply(this, arguments)

      if (typeof handleRequest !== 'function') return handleRequest

      return function handleRequestWithTrace (req, res) {
        web.instrument(tracer, config, req, res, 'koa.request')

        return handleRequest.apply(this, arguments)
      }
    }
  }
}

function createWrapCreateContext () {
  return function wrapCreateContext (createContext) {
    return function createContextWithTrace (req, res) {
      const ctx = createContext.apply(this, arguments)

      if (!ctx) return ctx

      web.patch(req)
      web.beforeEnd(req, () => {
        web.enterRoute(req, ctx.routePath)
      })

      return ctx
    }
  }
}

function createWrapUse (tracer, config) {
  return function wrapUse (use) {
    return function useWithTrace () {
      const result = use.apply(this, arguments)

      if (!Array.isArray(this.middleware)) return result

      const fn = this.middleware.pop()

      this.middleware.push(wrapMiddleware(fn, config))

      return result
    }
  }
}

function createWrapRegister (tracer, config) {
  return function wrapRegister (register) {
    return function registerWithTrace (path, methods, middleware, opts) {
      const route = register.apply(this, arguments)

      if (!Array.isArray(path) && route && Array.isArray(route.stack)) {
        wrapStack(route, config)
      }

      return route
    }
  }
}

function createWrapRoutes (tracer, config) {
  return function wrapRoutes (routes) {
    return function routesWithTrace () {
      const dispatch = routes.apply(this, arguments)
      const dispatchWithTrace = function (ctx, next) {
        if (!ctx.router) {
          let router

          Object.defineProperty(ctx, 'router', {
            set (value) {
              router = value

              for (const layer of router.stack) {
                wrapStack(layer, config)
              }
            },

            get () {
              return router
            }
          })
        }

        return dispatch.apply(this, arguments)
      }

      dispatchWithTrace.router = dispatch.router

      return dispatchWithTrace
    }
  }
}

function wrapStack (layer, config) {
  layer.stack = layer.stack.map(middleware => {
    if (typeof middleware !== 'function') return middleware

    const wrappedMiddleware = wrapMiddleware(middleware, config)

    return function (ctx, next) {
      if (!ctx || !web.active(ctx.req)) return middleware.apply(this, arguments)

      web.exitRoute(ctx.req)
      web.enterRoute(ctx.req, layer.path)

      return wrappedMiddleware.apply(this, arguments)
    }
  })
}

function wrapMiddleware (fn, config) {
  if (typeof fn !== 'function') return fn

  return function (ctx, next) {
    if (!ctx) return fn.apply(this, arguments)

    return web.wrapMiddleware(ctx.req, fn, config, 'koa.middleware', () => {
      try {
        const result = fn.apply(this, arguments)

        if (result && typeof result.then === 'function') {
          result.then(
            () => web.finish(ctx.req),
            err => web.finish(ctx.req, err)
          )
        } else {
          web.finish(ctx.req)
        }

        return result
      } catch (e) {
        web.finish(ctx.req, e)
        throw e
      }
    })
  }
}

module.exports = [
  {
    name: 'koa',
    versions: ['>=2'],
    patch (Koa, tracer, config) {
      this.wrap(Koa.prototype, 'callback', createWrapCallback(tracer, config))
      this.wrap(Koa.prototype, 'createContext', createWrapCreateContext(tracer, config))
      this.wrap(Koa.prototype, 'use', createWrapUse(tracer, config))
    },
    unpatch (Koa) {
      this.unwrap(Koa.prototype, 'callback')
      this.unwrap(Koa.prototype, 'createContext')
      this.unwrap(Koa.prototype, 'use')
    }
  },
  {
    name: '@koa/router',
    versions: ['>=8'],
    patch (Router, tracer, config) {
      this.wrap(Router.prototype, 'routes', createWrapRoutes(tracer, config))
      this.wrap(Router.prototype, 'middleware', createWrapRoutes(tracer, config))
    },
    unpatch (Router) {
      this.unwrap(Router.prototype, 'routes')
      this.unwrap(Router.prototype, 'middleware')
    }
  },
  {
    name: 'koa-router',
    versions: ['>7'],
    patch (Router, tracer, config) {
      this.wrap(Router.prototype, 'routes', createWrapRoutes(tracer, config))
      this.wrap(Router.prototype, 'middleware', createWrapRoutes(tracer, config))
    },
    unpatch (Router) {
      this.unwrap(Router.prototype, 'routes')
      this.unwrap(Router.prototype, 'middleware')
    }
  },
  {
    name: 'koa-router',
    versions: ['7'],
    patch (Router, tracer, config) {
      this.wrap(Router.prototype, 'register', createWrapRegister(tracer, config))
    },
    unpatch (Router) {
      this.unwrap(Router.prototype, 'register')
    }
  }
]
