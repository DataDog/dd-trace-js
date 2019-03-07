'use strict'

const web = require('./util/web')

function createWrapUse (tracer, config) {
  config = web.normalizeConfig(config)

  function ddTrace (ctx, next) {
    web.instrument(tracer, config, ctx.req, ctx.res, 'koa.request')

    return next()
  }

  return function wrapUse (use) {
    return function useWithTrace () {
      if (!this._datadog_trace_patched) {
        this._datadog_trace_patched = true
        use.call(this, ddTrace)
      }

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
      this.wrap(Koa.prototype, 'use', createWrapUse(tracer, config))
    },
    unpatch (Koa) {
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
