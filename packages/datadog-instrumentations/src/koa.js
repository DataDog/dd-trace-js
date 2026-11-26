'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel, createErrorPublisher } = require('./helpers/instrument')
const { routerMiddleware, middlewareRoute } = require('./helpers/koa-router-metadata')

const enterChannel = channel('apm:koa:middleware:enter')
const exitChannel = channel('apm:koa:middleware:exit')
const errorChannel = channel('apm:koa:middleware:error')
const nextChannel = channel('apm:koa:middleware:next')
const finishChannel = channel('apm:koa:middleware:finish')
const handleChannel = channel('apm:koa:request:handle')
const routeChannel = channel('apm:koa:request:route')
const publishError = createErrorPublisher(errorChannel)

function wrapCallback (callback) {
  return function callbackWithTrace (...args) {
    const handleRequest = callback.apply(this, args)

    if (typeof handleRequest !== 'function') return handleRequest

    return function handleRequestWithTrace (req, res) {
      handleChannel.publish({ req, res })

      return handleRequest.apply(this, arguments)
    }
  }
}

function wrapUse (use) {
  return function useWithTrace (...args) {
    const result = use.apply(this, args)

    if (Array.isArray(this.middleware)) {
      const fn = this.middleware.pop()

      this.middleware.push(wrapMiddleware(fn))
    }

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
  return function useWithTrace (...args) {
    const router = use.apply(this, args)

    for (const layer of router.stack) {
      wrapStack(layer)
    }

    return router
  }
}

function wrapStack (layer) {
  layer.stack = layer.stack.map(middleware => {
    if (typeof middleware !== 'function') return middleware

    middleware = routerMiddleware.get(middleware)?.original ?? middleware

    const handler = shimmer.wrapFunction(middleware, middleware => wrapMiddleware(middleware, layer))

    routerMiddleware.set(handler, { original: middleware, layer })

    return handler
  })
}

function wrapMiddleware (fn, layer) {
  if (typeof fn !== 'function') return fn

  const name = fn.name

  const handler = shimmer.wrapFunction(fn, fn => function (ctx, next) {
    if (!ctx || !enterChannel.hasSubscribers) return fn.apply(this, arguments)

    const req = ctx.req

    enterChannel.publish({ req, name, route: middlewareRoute(layer), context: ctx, middleware: handler })

    if (typeof next === 'function') {
      arguments[1] = wrapNext(req, next)
    }

    try {
      const result = fn.apply(this, arguments)

      if (result && typeof result.then === 'function') {
        return result.then(
          result => {
            fulfill(ctx)
            return result
          },
          err => {
            fulfill(ctx, err)
            throw err
          }
        )
      }
      fulfill(ctx)
      return result
    } catch (e) {
      fulfill(ctx, e)
      throw e
    } finally {
      exitChannel.publish({ req })
    }
  })

  return handler
}

function fulfill (ctx, error) {
  const req = ctx.req
  const route = ctx.routePath

  if (error) {
    publishError({ req, error })
  }

  // TODO: make sure that the parent class cannot override this in `enter`
  if (route) {
    routeChannel.publish({ req, route })
  }

  finishChannel.publish({ req })
}

function wrapNext (req, next) {
  return shimmer.wrapFunction(next, next => function (...args) {
    nextChannel.publish({ req })

    return next.apply(this, args)
  })
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
