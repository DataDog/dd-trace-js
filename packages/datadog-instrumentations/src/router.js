'use strict'

const METHODS = [...require('http').METHODS.map(v => v.toLowerCase()), 'all']
const shimmer = require('../../datadog-shimmer')
const { addHook, channel, publishError } = require('./helpers/instrument')
const { getCompileToRegexp } = require('./path-to-regexp')

const {
  getRouterMountPaths,
  joinPath,
  setLayerMatchers,
  isAppMounted,
  setRouterMountPath,
  extractMountPaths,
  getRouteFullPaths,
  wrapRouteMethodsAndPublish,
  collectRoutesFromRouter,
} = require('./helpers/router-helper')

function isFastStar (layer, matchers) {
  return layer.regexp?.fast_star ?? matchers.hasStarPath
}

function isFastSlash (layer, matchers) {
  return layer.regexp?.fast_slash ?? matchers.hasSlashPath
}

// TODO: Move this function to a shared file between Express and Router
/**
 * @param {string} name Channel namespace (`apm:<name>:middleware:*`).
 * @param {((pattern: string | RegExp) => RegExp | undefined) | undefined} compile
 *   Host-resolved path-to-regexp compile adapter, or undefined when the host
 *   instance ships no path-to-regexp. Captured here so each express/router
 *   instance keeps the dialect it actually loaded.
 */
function createWrapRouterMethod (name, compile) {
  const enterChannel = channel(`apm:${name}:middleware:enter`)
  const exitChannel = channel(`apm:${name}:middleware:exit`)
  const finishChannel = channel(`apm:${name}:middleware:finish`)
  const errorChannel = channel(`apm:${name}:middleware:error`)
  const nextChannel = channel(`apm:${name}:middleware:next`)
  const routeAddedChannel = channel(`apm:${name}:route:added`)

  function wrapLayerHandle (layer, original, matchers) {
    // Resolve `name` once at wrap time: cached on the original for any code
    // that reads `_name`, captured in the closure so the per-call body avoids
    // the property-lookup / `||` fallback.
    const name = original._name || layer.name || original.name
    original._name = name

    // Wrap-time matcher analysis. The single-pattern case yields a constant
    // route; only multi-pattern stacks need a per-request layer.path match.
    let captureRoute
    let needMultiMatch = false
    if (matchers.length !== 0 && !isFastStar(layer, matchers) && !isFastSlash(layer, matchers)) {
      if (matchers.length === 1) {
        captureRoute = matchers[0].path
      } else {
        needMultiMatch = true
      }
    }

    // Split by arity: router only ever dispatches 3-arg request handlers
    // through `Layer.handleRequest` and 4-arg error handlers through
    // `Layer.handleError`. Specialising lets the per-call body use named
    // parameters and `.call`, avoiding the rest-spread Array allocation that
    // the unified shape forced on every middleware invocation.
    return original.length === 4
      ? shimmer.wrapFunction(original, errorHandlerLayerWrap(layer, name, captureRoute, needMultiMatch, matchers))
      : shimmer.wrapFunction(original, requestHandlerLayerWrap(layer, name, captureRoute, needMultiMatch, matchers))
  }

  function requestHandlerLayerWrap (layer, name, captureRoute, needMultiMatch, matchers) {
    return original => function (req, res, next) {
      if (!enterChannel.hasSubscribers) return original.call(this, req, res, next)

      const wrappedNext = typeof next === 'function' ? wrapNext(req, next) : next

      let route = captureRoute
      if (needMultiMatch) {
        for (const matcher of matchers) {
          if (matcher.regex?.test(layer.path)) {
            route = matcher.path
            break
          }
        }
      }

      enterChannel.publish({ name, req, route, layer })

      try {
        return original.call(this, req, res, wrappedNext)
      } catch (error) {
        publishError(errorChannel, { req, error })
        nextChannel.publish({ req })
        finishChannel.publish({ req })

        throw error
      } finally {
        exitChannel.publish({ req })
      }
    }
  }

  function errorHandlerLayerWrap (layer, name, captureRoute, needMultiMatch, matchers) {
    return original => function (error, req, res, next) {
      if (!enterChannel.hasSubscribers) return original.call(this, error, req, res, next)

      const wrappedNext = typeof next === 'function' ? wrapNext(req, next) : next

      let route = captureRoute
      if (needMultiMatch) {
        for (const matcher of matchers) {
          if (matcher.regex?.test(layer.path)) {
            route = matcher.path
            break
          }
        }
      }

      enterChannel.publish({ name, req, route, layer })

      try {
        return original.call(this, error, req, res, wrappedNext)
      } catch (caught) {
        publishError(errorChannel, { req, error: caught })
        nextChannel.publish({ req })
        finishChannel.publish({ req })

        throw caught
      } finally {
        exitChannel.publish({ req })
      }
    }
  }

  function wrapStack (layers, matchers) {
    for (const layer of layers) {
      if (layer.__handle) { // express-async-errors
        layer.__handle = wrapLayerHandle(layer, layer.__handle, matchers)
      } else {
        layer.handle = wrapLayerHandle(layer, layer.handle, matchers)
      }

      setLayerMatchers(layer, matchers)

      if (layer.route) {
        for (const method of METHODS) {
          if (typeof layer.route.stack === 'function') {
            layer.route.stack = [{ handle: layer.route.stack }]
          }

          layer.route[method] = wrapMethod(layer.route[method])
        }
      }
    }
  }

  function wrapNext (req, originalNext) {
    // Per layer dispatch, N per request. Named `next`/arity-1 mirrors the
    // router continuation so wrapCallback skips its name/length rewrite.
    return shimmer.wrapCallback(originalNext, original => function next (error) {
      if (error && error !== 'route' && error !== 'router') {
        publishError(errorChannel, { req, error })
      }

      nextChannel.publish({ req })
      finishChannel.publish({ req })

      original.apply(this, arguments)
    })
  }

  function extractMatchers (fn) {
    const arg = Array.isArray(fn) ? fn.flat(Infinity) : [fn]

    if (typeof arg[0] === 'function') {
      return []
    }

    if (arg.length === 1) {
      const pattern = arg[0]
      const path = pattern instanceof RegExp ? `(${pattern})` : pattern
      const matchers = [{ path }]
      matchers.hasStarPath = path === '*'
      matchers.hasSlashPath = path === '/'
      return matchers
    }

    // hasStarPath/hasSlashPath cache the lookups isFastStar/isFastSlash
    // would otherwise re-run on every request.
    let hasStarPath = false
    let hasSlashPath = false
    const matchers = arg.map(pattern => {
      const isRegExp = pattern instanceof RegExp
      const path = isRegExp ? `(${pattern})` : pattern
      if (path === '*') {
        hasStarPath = true
      } else if (path === '/') {
        hasSlashPath = true
      }
      return {
        path,
        regex: isRegExp ? pattern : compile?.(pattern),
      }
    })
    matchers.hasStarPath = hasStarPath
    matchers.hasSlashPath = hasSlashPath
    return matchers
  }

  function wrapMethod (original) {
    return shimmer.wrapFunction(original, original => function methodWithTrace (...args) {
      let offset = 0
      if (this.stack) {
        offset = Array.isArray(this.stack) ? this.stack.length : 1
      }
      const router = original.apply(this, args)

      if (typeof this.stack === 'function') {
        this.stack = [{ handle: this.stack }]
      }

      if (routeAddedChannel.hasSubscribers) {
        routeAddedChannel.publish({ topOfStackFunc: methodWithTrace, layer: this.stack?.at(-1) })
      }

      const fn = args[0]

      // Publish only if this router was mounted by app.use() (prevents early '/sub/...')
      if (routeAddedChannel.hasSubscribers && isAppMounted(this) && this.stack?.length > offset) {
        // Handle nested router mounting for 'use' method
        if (original.name === 'use' && args.length >= 2) {
          const { mountPaths, startIdx } = extractMountPaths(fn)

          if (mountPaths.length) {
            const parentPaths = getRouterMountPaths(this)

            for (let i = startIdx; i < args.length; i++) {
              const nestedRouter = args[i]

              if (!nestedRouter || typeof nestedRouter !== 'function') continue

              for (const parentPath of parentPaths) {
                for (const normalizedMountPath of mountPaths) {
                  const fullMountPath = joinPath(parentPath, normalizedMountPath)
                  if (fullMountPath === null) continue

                  setRouterMountPath(nestedRouter, fullMountPath)
                  collectRoutesFromRouter(nestedRouter, fullMountPath)
                }
              }
            }
          }
        }

        const mountPaths = getRouterMountPaths(this)

        if (mountPaths.length) {
          const layer = this.stack.at(-1)

          if (layer?.route) {
            const route = layer.route

            const fullPaths = mountPaths.flatMap(mountPath => getRouteFullPaths(route, mountPath))

            wrapRouteMethodsAndPublish(route, fullPaths, (payload) => {
              routeAddedChannel.publish(payload)
            })
          }
        }
      }

      if (this.stack?.length > offset) {
        wrapStack(this.stack.slice(offset), extractMatchers(fn))
      }

      return router
    })
  }

  return wrapMethod
}

addHook({ name: 'router', versions: ['>=1 <2'] }, Router => {
  const wrapRouterMethod = createWrapRouterMethod('router', getCompileToRegexp())

  shimmer.wrap(Router.prototype, 'use', wrapRouterMethod)
  shimmer.wrap(Router.prototype, 'route', wrapRouterMethod)

  return Router
})

const queryParserReadCh = channel('datadog:query:read:finish')

addHook({ name: 'router', versions: ['>=2'] }, Router => {
  const wrapRouterMethod = createWrapRouterMethod('router', getCompileToRegexp())

  const WrappedRouter = shimmer.wrapFunction(Router, function (originalRouter) {
    return function wrappedMethod (...args) {
      const router = originalRouter.apply(this, args)

      shimmer.wrap(router, 'handle', function wrapHandle (originalHandle) {
        return function wrappedHandle (req, res, next) {
          if (queryParserReadCh.hasSubscribers && req) {
            const abortController = new AbortController()

            queryParserReadCh.publish({ req, res, query: req.query, abortController })

            if (abortController.signal.aborted) return
          }

          return originalHandle.call(this, req, res, next)
        }
      })

      return router
    }
  })

  shimmer.wrap(WrappedRouter.prototype, 'use', wrapRouterMethod)
  shimmer.wrap(WrappedRouter.prototype, 'route', wrapRouterMethod)

  return WrappedRouter
})

const routerParamStartCh = channel('datadog:router:param:start')
const visitedParams = new WeakSet()

function wrapHandleRequest (original) {
  return function wrappedHandleRequest (...args) {
    const req = args[0]
    if (routerParamStartCh.hasSubscribers && !visitedParams.has(req.params) && Object.keys(req.params).length) {
      visitedParams.add(req.params)

      const abortController = new AbortController()

      routerParamStartCh.publish({
        req,
        res: args[1],
        params: req?.params,
        abortController,
      })

      if (abortController.signal.aborted) return
    }

    return Reflect.apply(original, this, args)
  }
}

addHook({
  name: 'router', file: 'lib/layer.js', versions: ['>=2'],
}, Layer => {
  shimmer.wrap(Layer.prototype, 'handleRequest', wrapHandleRequest)
  return Layer
})

function wrapParam (original) {
  return function wrappedProcessParams (...args) {
    args[1] = shimmer.wrapFunction(args[1], (originalFn) => {
      return function wrappedFn (...fnArgs) {
        const req = fnArgs[0]
        if (routerParamStartCh.hasSubscribers && Object.keys(req.params).length && !visitedParams.has(req.params)) {
          visitedParams.add(req.params)

          const abortController = new AbortController()

          routerParamStartCh.publish({
            req,
            res: fnArgs[1],
            params: req?.params,
            abortController,
          })

          if (abortController.signal.aborted) return
        }

        return Reflect.apply(originalFn, this, fnArgs)
      }
    })

    return original.apply(this, args)
  }
}

addHook({
  name: 'router', versions: ['>=2'],
}, router => {
  shimmer.wrap(router.prototype, 'param', wrapParam)
  return router
})

module.exports = { createWrapRouterMethod }
