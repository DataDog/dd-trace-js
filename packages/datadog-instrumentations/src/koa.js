'use strict'

const { isProxy } = require('node:util').types

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

/** @type {WeakMap<Function, unknown>} */
const allowedMethodsOptions = new WeakMap()
const defaultAllowedMethodsOptions = {}
const allowedMethodsErrors = ['notImplemented', 'methodNotAllowed']
/** @type {WeakMap<Function, Function[]>} */
const callbackStacks = new WeakMap()

channel('tracing:orchestrion:koa:callback:end').subscribe(({ handleRequest, stack }) => {
  callbackStacks.set(handleRequest, stack)
})

for (const name of ['koa-router', '@koa/router']) {
  channel(`tracing:orchestrion:${name}:allowedMethods:end`).subscribe(({ arguments: args, result }) => {
    if (typeof result === 'function') {
      allowedMethodsOptions.set(result, args[0] || defaultAllowedMethodsOptions)
    }
  })
}

/**
 * @param {object} options
 * @param {object | null} prototype
 * @param {string} name
 */
function getMethodOption (options, prototype, name) {
  return Object.getOwnPropertyDescriptor(options, name) ??
    (prototype ? Object.getOwnPropertyDescriptor(prototype, name) : undefined)
}

/** @param {unknown} options */
function usesDefaultMethodErrors (options) {
  if (!options || typeof options !== 'object' || isProxy(options)) return false

  const prototype = Object.getPrototypeOf(options)
  if (prototype !== null && prototype !== Object.prototype) return false

  // Inspect the live options without invoking application getters or error factories.
  const throwOption = getMethodOption(options, prototype, 'throw')
  if (!throwOption) return true
  if (!Object.hasOwn(throwOption, 'value')) return false
  if (!throwOption.value) return true

  for (const name of allowedMethodsErrors) {
    const option = getMethodOption(options, prototype, name)
    if (option && (!Object.hasOwn(option, 'value') || typeof option.value === 'function')) return false
  }
  return true
}

/**
 * @param {Function} callback
 * @param {boolean} hasFixedCompose
 */
function wrapCallback (callback, hasFixedCompose) {
  return function callbackWithTrace (...args) {
    let stack = hasFixedCompose ? this.middleware : undefined
    const handleRequest = callback.apply(this, args)
    if (!hasFixedCompose) {
      stack = callbackStacks.get(handleRequest)
      callbackStacks.delete(handleRequest)
    }

    /** @type {((middleware: Function) => boolean) | undefined} */
    let isFinalRouteStage
    if (stack !== undefined) {
      isFinalRouteStage = middleware => {
        for (let index = stack.length - 1; index >= 0; index--) {
          const stage = stack[index]
          if (stage === middleware) {
            return true
          }
          if (!usesDefaultMethodErrors(allowedMethodsOptions.get(stage))) {
            break
          }
        }
        return false
      }
    }

    return function handleRequestWithTrace (req, res) {
      if (handleChannel.hasSubscribers) {
        handleChannel.publish({ req, res, isFinalRouteStage })
      }

      return handleRequest.apply(this, arguments)
    }
  }
}

function wrapUse (use) {
  return function useWithTrace (...args) {
    const result = use.apply(this, args)

    const stack = this.middleware
    if (Array.isArray(stack)) {
      const native = stack.pop()
      const handler = wrapMiddleware(native)
      stack.push(handler)
      const options = allowedMethodsOptions.get(native)
      if (options !== undefined) {
        allowedMethodsOptions.set(handler, options)
      }
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

/** @param {Function} update */
function wrapRouterStackUpdate (update) {
  return function updateWithTrace (...args) {
    const router = update.apply(this, args)

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

addHook({ name: 'koa', versions: ['>=2'] }, (Koa, version) => {
  const hasFixedCompose = version.startsWith('2.')
  shimmer.wrap(Koa.prototype, 'callback', callback => wrapCallback(callback, hasFixedCompose))
  shimmer.wrap(Koa.prototype, 'use', wrapUse)

  return Koa
})

addHook({ name: '@koa/router', versions: ['>=8'] }, Router => {
  shimmer.wrap(Router.prototype, 'register', wrapRegister)
  shimmer.wrap(Router.prototype, 'use', wrapRouterStackUpdate)
  shimmer.wrap(Router.prototype, 'param', wrapRouterStackUpdate)

  return Router
})

addHook({ name: 'koa-router', versions: ['>=7'] }, Router => {
  shimmer.wrap(Router.prototype, 'register', wrapRegister)
  shimmer.wrap(Router.prototype, 'use', wrapRouterStackUpdate)
  shimmer.wrap(Router.prototype, 'param', wrapRouterStackUpdate)

  return Router
})
