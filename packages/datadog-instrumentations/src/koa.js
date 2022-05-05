'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel, AsyncResource } = require('./helpers/instrument')

const enterChannel = channel('apm:koa:middleware:enter')
const errorChannel = channel('apm:koa:middleware:error')
const exitChannel = channel('apm:koa:middleware:exit')
const handleChannel = channel('apm:koa:request:handle')
const routeChannel = channel('apm:koa:request:route')

const originals = new WeakMap()

function wrapCallback (callback) {
  return function callbackWithTrace () {
    const handleRequest = callback.apply(this, arguments)

    if (typeof handleRequest !== 'function') return handleRequest

    return function handleRequestWithTrace (req, res) {
      handleChannel.publish({ req, res })

      return handleRequest.apply(this, arguments)
    }
  }
}

function wrapUse (use) {
  return function useWithTrace () {
    const result = use.apply(this, arguments)

    if (!Array.isArray(this.middleware)) return result

    const fn = this.middleware.pop()

    this.middleware.push(wrapMiddleware(fn))

    return result
  }
}

function wrapRegister (register) {
  return function registerWithTrace (path, methods, middleware, opts) {
    const route = register.apply(this, arguments)

    if (!Array.isArray(path) && route && Array.isArray(route.stack)) {
      wrapStack(route)
    }

    return route
  }
}

function wrapRouterUse (use) {
  return function useWithTrace () {
    const router = use.apply(this, arguments)

    router.stack.forEach(wrapStack)

    return router
  }
}

function wrapStack (layer) {
  layer.stack = layer.stack.map(middleware => {
    if (typeof middleware !== 'function') return middleware

    const original = originals.get(middleware)

    middleware = original || middleware

    const handler = shimmer.wrap(middleware, wrapMiddleware(middleware, layer))

    originals.set(handler, middleware)

    return handler
  })
}

function wrapMiddleware (fn, layer) {
  if (typeof fn !== 'function') return fn

  const name = fn.name

  return function (ctx, next) {
    if (!ctx || !enterChannel.hasSubscribers) return fn.apply(this, arguments)

    const middlewareResource = new AsyncResource('bound-anonymous-fn')
    const req = ctx.req

    return middlewareResource.runInAsyncScope(() => {
      enterChannel.publish({ req, name })

      if (typeof next === 'function') {
        arguments[1] = AsyncResource.bind(next)
      }

      try {
        const result = fn.apply(this, arguments)

        if (result && typeof result.then === 'function') {
          return result.then(
            result => {
              exit(ctx, layer)
              return result
            },
            err => {
              exit(ctx, layer, err)
              throw err
            }
          )
        } else {
          exit(ctx, layer)
          return result
        }
      } catch (e) {
        exit(ctx, layer, e)
        throw e
      }
    })
  }
}

function exit (ctx, layer, error) {
  if (error) {
    errorChannel.publish(error)
  }

  const req = ctx.req
  const route = ctx.routePath || (layer && layer.path)

  // TODO: make sure that the parent class cannot override this in `enter`
  if (route) {
    routeChannel.publish({ req, route })
  }

  exitChannel.publish(ctx)
}

addHook({ name: 'koa', versions: ['>=2'] }, Koa => {
  shimmer.wrap(Koa.prototype, 'callback', wrapCallback)
  shimmer.wrap(Koa.prototype, 'use', wrapUse)

  return Koa
})

addHook({ name: '@koa/router', versions: ['>=8'] }, Router => {
  shimmer.wrap(Router.prototype, 'register', wrapRegister)
  shimmer.wrap(Router.prototype, 'use', wrapRouterUse)

  return Router
})

addHook({ name: 'koa-router', versions: ['>=7'] }, Router => {
  shimmer.wrap(Router.prototype, 'register', wrapRegister)
  shimmer.wrap(Router.prototype, 'use', wrapRouterUse)

  return Router
})
