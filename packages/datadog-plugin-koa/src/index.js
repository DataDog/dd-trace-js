'use strict'

const web = require('../../dd-trace/src/plugins/util/web')

function createWrapCallback (tracer, config) {
  config = web.normalizeConfig(config)

  return function wrapCallback (callback) {
    return function callbackWithTrace () {
      const handleRequest = callback.apply(this, arguments)

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

      web.patch(req)
      web.beforeEnd(req, () => {
        web.enterRoute(ctx.req, ctx.routePath)
      })

      return ctx
    }
  }
}

function createWrapUse () {
  return function wrapUse (use) {
    return function useWithTrace () {
      const result = use.apply(this, arguments)
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

      if (Array.isArray(path)) return route

      route.stack = route.stack.map(middleware => {
        return function (ctx, next) {
          if (!web.active(ctx.req)) return middleware.apply(this, arguments)

          web.exitRoute(ctx.req)
          web.enterRoute(ctx.req, route.path)

          return wrapMiddleware(middleware).apply(this, arguments)
        }
      })

      return route
    }
  }
}

function wrapMiddleware (fn) {
  return function (ctx, next) {
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
    name: 'koa-router',
    versions: ['>=7'],
    patch (Router, tracer, config) {
      this.wrap(Router.prototype, 'register', createWrapRegister(tracer, config))
    },
    unpatch (Router) {
      this.unwrap(Router.prototype, 'register')
    }
  }
]
