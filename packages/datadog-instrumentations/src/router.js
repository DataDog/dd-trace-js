'use strict'

const METHODS = [...require('http').METHODS.map(v => v.toLowerCase()), 'all']
const shimmer = require('../../datadog-shimmer')
const { addHook, channel, createErrorPublisher } = require('./helpers/instrument')
const { getCompileToRegexp } = require('./path-to-regexp')

const {
  getRouterMountPaths,
  joinPath,
  setLayerMeta,
  getLayerMeta,
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

/**
 * Cache the per-layer dispatch metadata in a side table instead of replacing
 * `layer.handle`. Phase-sorting hosts (loopback's `_findLayerByHandler`) map a
 * layer back to the user handler by scanning the handle, so the handle has to
 * stay the user's function.
 *
 * @param {{ handle: Function, name?: string, path?: string,
 *   regexp?: { fast_star?: boolean, fast_slash?: boolean } }} layer
 * @param {Array<{ path?: string, regex?: RegExp }> & { hasStarPath?: boolean, hasSlashPath?: boolean }} matchers
 */
function annotateLayer (layer, matchers) {
  const handle = layer.handle
  const name = handle._name || layer.name || handle.name

  let captureRoute
  let needMultiMatch = false
  if (matchers.length !== 0 && !isFastStar(layer, matchers) && !isFastSlash(layer, matchers)) {
    if (matchers.length === 1) {
      captureRoute = matchers[0].path
    } else {
      needMultiMatch = true
    }
  }

  setLayerMeta(layer, { name, captureRoute, needMultiMatch, matchers })
}

/**
 * Resolve the route for a dispatched layer. Single-pattern layers carry a
 * constant route; only multi-pattern stacks need the per-request `layer.path`
 * match the host already computed.
 *
 * @param {{ captureRoute?: string, needMultiMatch: boolean,
 *   matchers: Array<{ path?: string, regex?: RegExp }> }} meta
 * @param {{ path?: string }} layer
 * @returns {string | undefined}
 */
function resolveLayerRoute (meta, layer) {
  if (!meta.needMultiMatch) return meta.captureRoute

  for (const matcher of meta.matchers) {
    if (matcher.regex?.test(layer.path)) return matcher.path
  }
}

/**
 * Build the request/error dispatch wrappers for one host (`express` / `router`).
 * They wrap the layer's prototype dispatch and read the side-table metadata, so
 * `layer.handle` is never replaced. The arity guard mirrors the host's own
 * (`handle_request` skips 4-arg handlers, `handle_error` skips the rest), so a
 * span is published only for the layer the host actually runs.
 *
 * @param {string} name Channel namespace (`apm:<name>:middleware:*`).
 */
function createLayerDispatchWrappers (name) {
  const enterChannel = channel(`apm:${name}:middleware:enter`)
  const exitChannel = channel(`apm:${name}:middleware:exit`)
  const finishChannel = channel(`apm:${name}:middleware:finish`)
  const errorChannel = channel(`apm:${name}:middleware:error`)
  const nextChannel = channel(`apm:${name}:middleware:next`)
  // Bound per name so express and a bare router keep independent guards.
  const publishError = createErrorPublisher(errorChannel)

  function wrapNext (req, originalNext) {
    // Per layer dispatch, N per request. Named `next`/arity-1 mirrors the
    // router continuation so wrapCallback skips its name/length rewrite.
    return shimmer.wrapCallback(originalNext, original => function next (error) {
      if (error && error !== 'route' && error !== 'router') {
        publishError({ req, error })
      }

      nextChannel.publish({ req })
      finishChannel.publish({ req })

      original.apply(this, arguments)
    })
  }

  // A synchronous throw or a rejected promise is turned into `next(error)` by
  // the host's own dispatch, so passing `wrappedNext` through captures both
  // without a tracer-side try/catch; only `exit` needs the `finally`.
  function wrapLayerRequest (originalRequest) {
    return function (req, res, next) {
      if (!enterChannel.hasSubscribers) return originalRequest.call(this, req, res, next)

      const meta = getLayerMeta(this)
      if (meta === undefined || this.handle.length > 3) return originalRequest.call(this, req, res, next)

      const wrappedNext = typeof next === 'function' ? wrapNext(req, next) : next
      enterChannel.publish({ name: meta.name, req, route: resolveLayerRoute(meta, this), layer: this })

      try {
        return originalRequest.call(this, req, res, wrappedNext)
      } finally {
        exitChannel.publish({ req })
      }
    }
  }

  function wrapLayerError (originalError) {
    return function (error, req, res, next) {
      if (!enterChannel.hasSubscribers) return originalError.call(this, error, req, res, next)

      const meta = getLayerMeta(this)
      if (meta === undefined || this.handle.length !== 4) return originalError.call(this, error, req, res, next)

      const wrappedNext = typeof next === 'function' ? wrapNext(req, next) : next
      enterChannel.publish({ name: meta.name, req, route: resolveLayerRoute(meta, this), layer: this })

      try {
        return originalError.call(this, error, req, res, wrappedNext)
      } finally {
        exitChannel.publish({ req })
      }
    }
  }

  return { wrapLayerRequest, wrapLayerError }
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
  const routeAddedChannel = channel(`apm:${name}:route:added`)

  function wrapStack (layers, matchers) {
    for (const layer of layers) {
      annotateLayer(layer, matchers)

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

addHook({ name: 'router', file: 'lib/layer.js', versions: ['>=1 <2'] }, Layer => {
  const { wrapLayerRequest, wrapLayerError } = createLayerDispatchWrappers('router')

  shimmer.wrap(Layer.prototype, 'handle_request', wrapLayerRequest)
  shimmer.wrap(Layer.prototype, 'handle_error', wrapLayerError)

  return Layer
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
  const { wrapLayerRequest, wrapLayerError } = createLayerDispatchWrappers('router')

  shimmer.wrap(Layer.prototype, 'handleRequest', wrapLayerRequest)
  shimmer.wrap(Layer.prototype, 'handleError', wrapLayerError)
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

module.exports = { createWrapRouterMethod, createLayerDispatchWrappers }
