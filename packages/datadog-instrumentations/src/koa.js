'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel } = require('./helpers/instrument')

const enterChannel = channel('apm:koa:middleware:enter')
const exitChannel = channel('apm:koa:middleware:exit')
const errorChannel = channel('apm:koa:middleware:error')
const nextChannel = channel('apm:koa:middleware:next')
const finishChannel = channel('apm:koa:middleware:finish')
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

    for (const layer of router.stack) {
      wrapStack(layer)
    }

    return router
  }
}

function wrapStack (layer) {
  const newStack = []
  for (const middleware of layer.stack) {
    if (typeof middleware === 'function') {
      const original = originals.get(middleware) || middleware

      const handler = shimmer.wrapFunction(original, middleware => wrapMiddleware(middleware, layer))
      originals.set(handler, original)
      newStack.push(handler)
    }
  }
  layer.stack = newStack
}

function wrapMiddleware (fn, layer) {
  if (typeof fn !== 'function') return fn

  const name = fn.name

  return shimmer.wrapFunction(fn, fn => function (ctx, next) {
    if (!ctx || !enterChannel.hasSubscribers) return fn.apply(this, arguments)

    const req = ctx.req

    const path = layer && layer.path
    const route = typeof path === 'string' && !path.endsWith('(.*)') && !path.endsWith('([^/]*)') && path

    enterChannel.publish({ req, name, route })

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
          error => {
            fulfill(ctx, error)
            throw error
          }
        )
      }
      fulfill(ctx)
      return result
    } catch (error) {
      fulfill(ctx, error)
      throw error
    } finally {
      exitChannel.publish({ req })
    }
  })
}

function fulfill (ctx, error) {
  const req = ctx.req
  const route = ctx.routePath

  if (error) {
    errorChannel.publish({ req, error })
  }

  // TODO: make sure that the parent class cannot override this in `enter`
  if (route) {
    routeChannel.publish({ req, route })
  }

  finishChannel.publish({ req })
}

function wrapNext (req, next) {
  return shimmer.wrapFunction(next, next => function () {
    nextChannel.publish({ req })

    return next.apply(this, arguments)
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
