'use strict'

const web = require('../../dd-trace/src/plugins/util/web')

const originals = new WeakMap()

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

function createWrapUse () {
  return function wrapUse (use) {
    return function useWithTrace () {
      const result = use.apply(this, arguments)

      if (!Array.isArray(this.middleware)) return result

      const fn = this.middleware.pop()

      this.middleware.push(wrapMiddleware(fn))

      return result
    }
  }
}

function createWrapRegister (tracer, config) {
  return function wrapRegister (register) {
    return function registerWithTrace (path, methods, middleware, opts) {
      const route = register.apply(this, arguments)

      if (!Array.isArray(path) && route && Array.isArray(route.stack)) {
        wrapStack(route)
      }

      return route
    }
  }
}

function createWrapRouterUse (tracer, config) {
  return function wrapUse (use) {
    return function useWithTrace () {
      const router = use.apply(this, arguments)

      router.stack.forEach(wrapStack)

      return router
    }
  }
}

function wrapStack (layer) {
  layer.stack = layer.stack.map(middleware => {
    if (typeof middleware !== 'function') return middleware

    const original = originals.get(middleware)

    middleware = original || middleware

    const wrappedMiddleware = wrapMiddleware(middleware)

    const handler = function (ctx, next) {
      if (!ctx || !web.active(ctx.req)) return middleware.apply(this, arguments)

      web.exitRoute(ctx.req)
      web.enterRoute(ctx.req, layer.path)

      return wrappedMiddleware.apply(this, arguments)
    }

    originals.set(handler, middleware)

    return handler
  })
}

function wrapMiddleware (fn) {
  if (typeof fn !== 'function') return fn

  return function (ctx, next) {
    if (!ctx) return fn.apply(this, arguments)

    return web.wrapMiddleware(ctx.req, fn, 'koa.middleware', () => {
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
      this.wrap(Router.prototype, 'register', createWrapRegister(tracer, config))
      this.wrap(Router.prototype, 'use', createWrapRouterUse(tracer, config))
    },
    unpatch (Router) {
      this.unwrap(Router.prototype, 'register')
      this.unwrap(Router.prototype, 'use')
    }
  },
  {
    name: 'koa-router',
    versions: ['>=7'],
    patch (Router, tracer, config) {
      this.wrap(Router.prototype, 'register', createWrapRegister(tracer, config))
      this.wrap(Router.prototype, 'use', createWrapRouterUse(tracer, config))
    },
    unpatch (Router) {
      this.unwrap(Router.prototype, 'register')
      this.unwrap(Router.prototype, 'use')
    }
  }
]
