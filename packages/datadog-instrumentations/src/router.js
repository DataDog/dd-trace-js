'use strict'

const METHODS = [...require('http').METHODS.map(v => v.toLowerCase()), 'all']
const shimmer = require('../../datadog-shimmer')
const { addHook, channel } = require('./helpers/instrument')
const { getCompileToRegexp } = require('./path-to-regexp')

const {
  getRouterMountPaths,
  joinPath,
  getLayerMatchers,
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

  function wrapLayerHandle (layer, original) {
    original._name = original._name || layer.name

    return shimmer.wrapFunction(original, original => function () {
      if (!enterChannel.hasSubscribers) return original.apply(this, arguments)

      const matchers = getLayerMatchers(layer)
      const lastIndex = arguments.length - 1
      const name = original._name || original.name
      const req = arguments[arguments.length > 3 ? 1 : 0]
      const next = arguments[lastIndex]

      if (typeof next === 'function') {
        arguments[lastIndex] = wrapNext(req, next)
      }

      let route

      if (matchers?.length && !isFastStar(layer, matchers) && !isFastSlash(layer, matchers)) {
        if (matchers.length === 1) {
          // The host already matched this layer; the lone pattern is the route.
          route = matchers[0].path
        } else {
          for (const matcher of matchers) {
            if (matcher.regex?.test(layer.path)) {
              route = matcher.path
              break
            }
          }
        }
      }

      enterChannel.publish({ name, req, route, layer })

      try {
        return original.apply(this, arguments)
      } catch (error) {
        errorChannel.publish({ req, error })
        nextChannel.publish({ req })
        finishChannel.publish({ req })

        throw error
      } finally {
        exitChannel.publish({ req })
      }
    })
  }

  function wrapStack (layers, matchers) {
    for (const layer of layers) {
      if (layer.__handle) { // express-async-errors
        layer.__handle = wrapLayerHandle(layer, layer.__handle)
      } else {
        layer.handle = wrapLayerHandle(layer, layer.handle)
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

  function wrapNext (req, next) {
    return shimmer.wrapFunction(next, next => function (error) {
      if (error && error !== 'route' && error !== 'router') {
        errorChannel.publish({ req, error })
      }

      nextChannel.publish({ req })
      finishChannel.publish({ req })

      next.apply(this, arguments)
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
    return function wrappedMethod () {
      const router = originalRouter.apply(this, arguments)

      shimmer.wrap(router, 'handle', function wrapHandle (originalHandle) {
        return function wrappedHandle (req, res, next) {
          const abortController = new AbortController()

          if (queryParserReadCh.hasSubscribers && req) {
            queryParserReadCh.publish({ req, res, query: req.query, abortController })

            if (abortController.signal.aborted) return
          }

          return originalHandle.apply(this, arguments)
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
  return function wrappedHandleRequest (req, res, next) {
    if (routerParamStartCh.hasSubscribers && !visitedParams.has(req.params) && Object.keys(req.params).length) {
      visitedParams.add(req.params)

      const abortController = new AbortController()

      routerParamStartCh.publish({
        req,
        res,
        params: req?.params,
        abortController,
      })

      if (abortController.signal.aborted) return
    }

    return original.apply(this, arguments)
  }
}

addHook({
  name: 'router', file: 'lib/layer.js', versions: ['>=2'],
}, Layer => {
  shimmer.wrap(Layer.prototype, 'handleRequest', wrapHandleRequest)
  return Layer
})

function wrapParam (original) {
  return function wrappedProcessParams () {
    arguments[1] = shimmer.wrapFunction(arguments[1], (originalFn) => {
      return function wrappedFn (req, res) {
        if (routerParamStartCh.hasSubscribers && Object.keys(req.params).length && !visitedParams.has(req.params)) {
          visitedParams.add(req.params)

          const abortController = new AbortController()

          routerParamStartCh.publish({
            req,
            res,
            params: req?.params,
            abortController,
          })

          if (abortController.signal.aborted) return
        }

        return originalFn.apply(this, arguments)
      }
    })

    return original.apply(this, arguments)
  }
}

addHook({
  name: 'router', versions: ['>=2'],
}, router => {
  shimmer.wrap(router.prototype, 'param', wrapParam)
  return router
})

module.exports = { createWrapRouterMethod }
