'use strict'

const { join } = require('node:path')

const METHODS = [...require('http').METHODS.map(v => v.toLowerCase()), 'all']
const shimmer = require('../../datadog-shimmer')
const { addHook, channel, createErrorPublisher } = require('./helpers/instrument')
const { getRouteCompiler } = require('./path-to-regexp')

const {
  getRouterMountPaths,
  joinPath,
  setLayerMeta,
  getLayerMeta,
  takeNativeRouterMatch,
  resolveNativeRouterRoute,
  replayLayerRoute,
  isAppMounted,
  setRouterMountPath,
  extractMountPaths,
  getRouteFullPaths,
  wrapRouteMethodsAndPublish,
  collectRoutesFromRouter,
} = require('./helpers/router-helper')

const nativeRouteMatch = channel('tracing:orchestrion:router:routeMatch:start')

function isFastStar (layer, matchers) {
  return layer.regexp?.fast_star ?? matchers.hasStarPath
}

function isFastSlash (layer, matchers) {
  return layer.regexp?.fast_slash ?? (layer.route === undefined && matchers.hasSlashPath)
}

/**
 * Cache the per-layer dispatch metadata in a side table instead of replacing
 * `layer.handle`. Phase-sorting hosts (loopback's `_findLayerByHandler`) map a
 * layer back to the user handler by scanning the handle, so the handle has to
 * stay the user's function.
 *
 * @param {{ handle: Function, name?: string, path?: string, route?: object,
 *   matchers?: Function[], regexp?: { fast_star?: boolean, fast_slash?: boolean } }} layer
 * @param {import('./helpers/router-helper').LayerMatchers} matchers
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

  const nativeSingleGroup = needMultiMatch && layer.route !== undefined &&
    layer.matchers?.length === 1 && matchers.groups?.length === 1
  setLayerMeta(layer, { name, captureRoute, needMultiMatch, nativeSingleGroup, matchers })
}

/**
 * Preserve the host Layer's error boundary while resolving a route outside its
 * dispatch method. This path runs only for multi-pattern layers.
 *
 * @param {import('./helpers/router-helper').LayerMeta} meta
 * @param {{ req: import('node:http').IncomingMessage, layer: { path?: string },
 *   route?: string, routeSelected: boolean }} context
 * @param {Function} next
 * @param {symbol | undefined} matchedRoute
 * @param {boolean} captureLegacyMatch
 */
function resolveLayerRouteOrForwardError (meta, context, next, matchedRoute, captureLegacyMatch) {
  if (captureLegacyMatch && !nativeRouteMatch.hasSubscribers) {
    return true
  }

  const { req, layer } = context
  try {
    const dispatch = captureLegacyMatch ? takeNativeRouterMatch(req, layer) : undefined
    if (matchedRoute || dispatch?.index !== undefined || (captureLegacyMatch && meta.nativeSingleGroup)) {
      context.route = resolveNativeRouterRoute(meta, matchedRoute && req[matchedRoute], dispatch ?? layer)
      context.routeSelected = context.route !== undefined
    } else {
      context.route = replayLayerRoute(meta.matchers, dispatch?.path ?? layer.path, !captureLegacyMatch)
    }
    return true
  } catch (error) {
    next(error)
    return false
  }
}

// Wrapped `next` -> the host continuation it calls.
const hostNexts = new WeakMap()

/**
 * Routers store their continuation on `req.next` once per `handle()`, and host
 * APIs call it directly (express `res.format`, `res.sendFile` and `res.render`
 * errors). Point it at the wrapper the current handler receives when that
 * wrapper wraps the same continuation: `req.next` is the host continuation
 * itself, or an earlier layer's wrapper of it. Route handlers receive a
 * route-local continuation from `Route.dispatch`, so `req.next` keeps the
 * router-level one there. A nested router restores its parent's `req.next`
 * when it finishes.
 *
 * @param {import('node:http').IncomingMessage | undefined} req
 * @param {Function} hostNext
 * @param {Function} wrappedNext
 */
function adoptRequestNext (req, hostNext, wrappedNext) {
  hostNexts.set(wrappedNext, hostNext)
  if (req && (req.next === hostNext || hostNexts.get(req.next) === hostNext)) req.next = wrappedNext
}

/**
 * Build the request/error dispatch wrappers for one host (`express` / `router`).
 * They wrap the layer's prototype dispatch and read the side-table metadata, so
 * `layer.handle` is never replaced. The arity guard mirrors the host's own
 * (`handle_request` skips 4-arg handlers, `handle_error` skips the rest), so a
 * span is published only for the layer the host actually runs.
 *
 * @param {string} name Channel namespace (`apm:<name>:middleware:*`).
 * @param {symbol} [matchedRoute] Native request-local route key, when provided by the host.
 * @param {boolean} [captureLegacyMatch] The host provides an observed match before running its param callbacks.
 * @returns {{
 *   wrapLayerRequest: (originalRequest: Function) => Function,
 *   wrapLayerError: (originalError: Function) => Function,
 *   wrapLegacyHandle: (layer: object, original: Function, guardRepeatedNext?: boolean) => Function
 * }}
 */
function createLayerDispatchWrappers (name, matchedRoute, captureLegacyMatch = false) {
  const enterChannel = channel(`apm:${name}:middleware:enter`)
  const exitChannel = channel(`apm:${name}:middleware:exit`)
  const finishChannel = channel(`apm:${name}:middleware:finish`)
  const errorChannel = channel(`apm:${name}:middleware:error`)
  const nextChannel = channel(`apm:${name}:middleware:next`)
  const repeatChannel = channel(`apm:${name}:middleware:repeat`)
  // Bound per name so express and a bare router keep independent guards.
  const publishError = createErrorPublisher(errorChannel)

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {string | undefined} layerName
   * @param {(error?: unknown) => void} originalNext
   */
  function wrapNext (req, layerName, originalNext) {
    // Per layer dispatch, N per request. Named `next`/arity-1 mirrors the
    // router continuation so wrapCallback skips its name/length rewrite.
    let calls = 0
    return shimmer.wrapCallback(originalNext, original => function next (error) {
      // A handler that calls `next()` and then rejects (`next(); await bg()`)
      // makes the host call this continuation twice. Publish once so the second
      // pass cannot tag the already-finished span's parent with a late error.
      calls++
      if (calls === 1) {
        if (error && error !== 'route' && error !== 'router') {
          publishError({ req, error })
        }

        nextChannel.publish({ req })
        finishChannel.publish({ req })
      } else if (calls === 2) {
        // Surface the repeat as a diagnostic on the still-live request span. The
        // host cannot tell a legitimate `next(); await bg()` from a buggy double
        // `next()`, so this only records that it happened, not that it is wrong.
        repeatChannel.publish({ req, name: layerName, error })
      }

      original.apply(this, arguments)
    })
  }

  // Every host dispatch turns a synchronous throw into `next(error)`, and the
  // hosts that await the handler (router >=2, express 5, express 4 +
  // express-async-errors) do the same for a rejected promise. Passing
  // `wrappedNext` through captures both without a tracer-side try/catch; only
  // `exit` needs the `finally`. express 4's native dispatch converts only the
  // synchronous throw — exactly what the pre-refactor handle wrap caught.
  /**
   * @param {Function} originalRequest
   * @returns {Function}
   */
  function wrapLayerRequest (originalRequest) {
    return function (req, res, next) {
      if (!enterChannel.hasSubscribers) return originalRequest.call(this, req, res, next)

      const meta = getLayerMeta(this)
      if (meta === undefined || this.handle.length > 3) return originalRequest.call(this, req, res, next)

      const context = {
        name: meta.name, req, route: meta.captureRoute, layer: this, routeSelected: !meta.needMultiMatch,
      }
      if (meta.needMultiMatch &&
        !resolveLayerRouteOrForwardError(meta, context, next, matchedRoute, captureLegacyMatch)) {
        return
      }

      const wrappedNext = typeof next === 'function' ? wrapNext(req, meta.name, next) : next
      if (wrappedNext !== next) adoptRequestNext(req, next, wrappedNext)
      enterChannel.publish(context)

      try {
        return originalRequest.call(this, req, res, wrappedNext)
      } finally {
        exitChannel.publish({ req })
      }
    }
  }

  /**
   * @param {Function} originalError
   * @returns {Function}
   */
  function wrapLayerError (originalError) {
    return function (error, req, res, next) {
      if (!enterChannel.hasSubscribers) return originalError.call(this, error, req, res, next)

      const meta = getLayerMeta(this)
      if (meta === undefined || this.handle.length !== 4) return originalError.call(this, error, req, res, next)

      const context = {
        name: meta.name, req, route: meta.captureRoute, layer: this, routeSelected: !meta.needMultiMatch,
      }
      if (meta.needMultiMatch &&
        !resolveLayerRouteOrForwardError(meta, context, next, matchedRoute, captureLegacyMatch)) {
        return
      }

      const wrappedNext = typeof next === 'function' ? wrapNext(req, meta.name, next) : next
      if (wrappedNext !== next) adoptRequestNext(req, next, wrappedNext)
      enterChannel.publish(context)

      try {
        return originalError.call(this, error, req, res, wrappedNext)
      } finally {
        exitChannel.publish({ req })
      }
    }
  }

  // express <4.6.0 dispatches `layer.handle` directly, so its replacement must preserve arity.
  /**
   * @param {object} layer
   * @param {Function} original
   * @returns {Function}
   */
  function wrapNativeLegacyRequestHandle (layer, original) {
    const meta = getLayerMeta(layer)
    const { name, captureRoute, needMultiMatch } = meta
    return shimmer.wrapFunction(original, inner => function (req, res, next) {
      if (!enterChannel.hasSubscribers) return inner.call(this, req, res, next)

      let calls = 0
      if (typeof next === 'function') {
        const hostNext = next
        next = shimmer.wrapCallback(next, originalNext => function next (error) {
          calls++
          if (calls === 1) {
            if (error && error !== 'route' && error !== 'router') {
              publishError({ req, error })
            }

            nextChannel.publish({ req })
            finishChannel.publish({ req })
          } else if (calls === 2) {
            repeatChannel.publish({ req, name, error })
          }

          originalNext.apply(this, arguments)
        })
        adoptRequestNext(req, hostNext, next)
      }

      const route = needMultiMatch ? replayLayerRoute(meta.matchers, layer.path, true) : captureRoute
      enterChannel.publish({ name, req, route, layer, routeSelected: !needMultiMatch })

      try {
        return inner.call(this, req, res, next)
      } catch (error) {
        if (calls === 0) {
          calls = 1
          publishError({ req, error })
          nextChannel.publish({ req })
          finishChannel.publish({ req })
        }

        throw error
      } finally {
        exitChannel.publish({ req })
      }
    })
  }

  /**
   * @param {object} layer
   * @param {Function} original
   * @returns {Function}
   */
  function wrapNativeLegacyErrorHandle (layer, original) {
    const meta = getLayerMeta(layer)
    const { name, captureRoute, needMultiMatch } = meta
    return shimmer.wrapFunction(original, inner => function (error, req, res, next) {
      if (!enterChannel.hasSubscribers) return inner.call(this, error, req, res, next)

      let calls = 0
      if (typeof next === 'function') {
        const hostNext = next
        next = shimmer.wrapCallback(next, originalNext => function next (nextError) {
          calls++
          if (calls === 1) {
            if (nextError && nextError !== 'route' && nextError !== 'router') {
              publishError({ req, error: nextError })
            }

            nextChannel.publish({ req })
            finishChannel.publish({ req })
          } else if (calls === 2) {
            repeatChannel.publish({ req, name, error: nextError })
          }

          originalNext.apply(this, arguments)
        })
        adoptRequestNext(req, hostNext, next)
      }

      const route = needMultiMatch ? replayLayerRoute(meta.matchers, layer.path, true) : captureRoute
      enterChannel.publish({ name, req, route, layer })

      try {
        return inner.call(this, error, req, res, next)
      } catch (caught) {
        if (calls === 0) {
          calls = 1
          publishError({ req, error: caught })
          nextChannel.publish({ req })
          finishChannel.publish({ req })
        }

        throw caught
      } finally {
        exitChannel.publish({ req })
      }
    })
  }

  /**
   * @param {object} layer
   * @param {Function} original
   * @param {boolean} [guardRepeatedNext]
   * @returns {Function}
   */
  function wrapLegacyHandle (layer, original, guardRepeatedNext = false) {
    if (!guardRepeatedNext) {
      return original.length === 4
        ? wrapNativeLegacyErrorHandle(layer, original)
        : wrapNativeLegacyRequestHandle(layer, original)
    }

    // `annotateLayer` always runs first in `wrapStack`, so the captured meta is
    // never undefined here (unlike the prototype wraps, where `this` can be any
    // layer the host dispatches).
    const meta = getLayerMeta(layer)
    const { name, captureRoute, needMultiMatch } = meta
    const wrapped = shimmer.wrapFunction(original, inner => function (...args) {
      if (!enterChannel.hasSubscribers) return inner.apply(this, args)

      const isErrorHandler = original.length === 4
      const req = args[isErrorHandler ? 1 : 0]
      const nextIndex = isErrorHandler ? 3 : 2
      let calls = 0
      if (typeof args[nextIndex] === 'function') {
        const hostNext = args[nextIndex]
        args[nextIndex] = shimmer.wrapCallback(args[nextIndex], originalNext => function next (error) {
          calls++
          if (calls === 1) {
            if (error && error !== 'route' && error !== 'router') {
              publishError({ req, error })
            }

            nextChannel.publish({ req })
            finishChannel.publish({ req })
          } else if (calls === 2) {
            repeatChannel.publish({ req, name, error })
          }

          originalNext.apply(this, arguments)
        })
        adoptRequestNext(req, hostNext, args[nextIndex])
      }

      const route = needMultiMatch ? replayLayerRoute(meta.matchers, layer.path, true) : captureRoute
      enterChannel.publish({ name, req, route, layer, routeSelected: !needMultiMatch })

      try {
        return inner.apply(this, args)
      } catch (error) {
        // Legacy hosts catch outside the layer and never call its wrapped `next`, so finish before rethrowing.
        if (calls === 0) {
          calls = 1
          publishError({ req, error })
          nextChannel.publish({ req })
          finishChannel.publish({ req })
        }

        throw error
      } finally {
        exitChannel.publish({ req })
      }
    })
    Object.defineProperty(wrapped, 'length', { value: original.length, configurable: true })
    return wrapped
  }

  return { wrapLayerRequest, wrapLayerError, wrapLegacyHandle }
}

/**
 * @param {{ handle_request?: unknown, handleRequest?: unknown }} layer
 */
function hasLayerDispatch (layer) {
  return typeof layer.handle_request === 'function' || typeof layer.handleRequest === 'function'
}

// TODO: Move this function to a shared file between Express and Router
/**
 * @param {string} name Channel namespace (`apm:<name>:middleware:*`).
 * @param {import('./path-to-regexp').RouteCompiler | undefined} compile
 *   Host-resolved path-to-regexp compile adapter, or undefined when the host
 *   instance ships no path-to-regexp. Captured here so each express/router
 *   instance keeps the dialect it actually loaded.
 * @param {((layer: object, original: Function, guardRepeatedNext?: boolean) => Function) | undefined}
 *   [wrapLegacyHandle]
 *   Fallback that replaces `layer.handle` for hosts without a `Layer` prototype
 *   dispatch (express <4.6.0). Omitted for hosts that always ship one.
 * @returns {(original: Function) => Function}
 */
function createWrapRouterMethod (name, compile, wrapLegacyHandle) {
  const routeAddedChannel = channel(`apm:${name}:route:added`)

  function wrapStack (layers, matchers) {
    for (const layer of layers) {
      annotateLayer(layer, matchers)

      if (wrapLegacyHandle !== undefined && !hasLayerDispatch(layer)) {
        if (layer.__handle) { // express-async-errors
          layer.__handle = wrapLegacyHandle(layer, layer.__handle, true)
        } else {
          layer.handle = wrapLegacyHandle(layer, layer.handle)
        }
      }

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

  /**
   * @param {string | RegExp | Function | Array<string | RegExp>} fn
   * @param {{ caseSensitive?: boolean, strict?: boolean }} router
   * @param {{ route?: object, matchers?: Function[] }} layer
   */
  function extractMatchers (fn, router, layer) {
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
    const end = layer.route !== undefined
    const options = layer.matchers === undefined
      ? undefined
      : { sensitive: router.caseSensitive, end, trailing: !end || !router.strict }
    const matchers = arg.map(pattern => {
      const isRegExp = pattern instanceof RegExp
      const path = isRegExp ? `(${pattern})` : pattern
      if (path === '*') {
        hasStarPath = true
      } else if (path === '/') {
        hasSlashPath = true
      }
      let candidate = pattern
      if (options?.trailing && typeof pattern === 'string' && pattern !== '/') {
        let length = pattern.length
        while (pattern[length - 1] === '/') {
          length--
        }
        candidate = pattern.slice(0, length)
      }
      return { path, regex: isRegExp ? pattern : compile?.(candidate, options), isRegExp }
    })
    matchers.hasStarPath = hasStarPath
    matchers.hasSlashPath = hasSlashPath
    if (Array.isArray(fn) && fn.some(Array.isArray)) {
      let offset = 0
      matchers.groups = fn.map(pattern => {
        if (!Array.isArray(pattern)) return matchers[offset++]

        const start = offset
        offset += pattern.flat(Infinity).length
        return matchers.slice(start, offset)
      })
    }
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
        wrapStack(this.stack.slice(offset), extractMatchers(fn, this, this.stack[offset]))
      }

      return router
    })
  }

  return wrapMethod
}

addHook({ name: 'router', versions: ['>=1 <2'] }, Router => {
  const wrapRouterMethod = createWrapRouterMethod('router', getRouteCompiler())

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
const routeCreateCh = channel('datadog:router:route:create')

addHook({ name: 'router', versions: ['>=2'] }, (Router, version, isIitm, { moduleBaseDir } = {}) => {
  const hostFile = moduleBaseDir === undefined ? undefined : join(moduleBaseDir, 'lib/layer.js')
  const wrapRouterMethod = createWrapRouterMethod('router', getRouteCompiler(hostFile))

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
  shimmer.wrap(WrappedRouter.prototype, 'route', original => wrapRouterMethod(publishRouteCreate(original)))

  return WrappedRouter
})

/**
 * Publish the matching options of the Router that owns each new Route (a Router does not inherit
 * the app's settings), once at registration.
 * @param {(this: { caseSensitive?: boolean, strict?: boolean }, path: string) => object} original
 */
function publishRouteCreate (original) {
  return function (...args) {
    const route = original.apply(this, args)
    if (routeCreateCh.hasSubscribers) {
      routeCreateCh.publish({ route, sensitive: this.caseSensitive === true, strict: this.strict === true })
    }
    return route
  }
}

const routerParamStartCh = channel('datadog:router:param:start')
const visitedParams = new WeakSet()

function wrapHandleRequest (original) {
  return function wrappedHandleRequest (...args) {
    const req = args[0]
    // eslint-disable-next-line no-restricted-syntax -- arbitrary param names; publishing {} sets a WAF address
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

/** @type {Map<string | undefined, symbol>} */
const matchedRouteSymbols = new Map()

addHook({ name: 'router', file: 'lib/symbols.js', versions: ['>=2'] },
  /**
   * @param {{ matchedRoute: symbol }} symbols
   * @param {string} version
   * @param {boolean} isIitm
   * @param {{ moduleBaseDir?: string }} hookMeta
   */
  function captureMatchedRoute (symbols, version, isIitm, { moduleBaseDir }) {
    matchedRouteSymbols.set(moduleBaseDir, symbols.matchedRoute)
    return symbols
  })

addHook({
  name: 'router', file: 'lib/layer.js', versions: ['>=2'],
}, (Layer, version, isIitm, { moduleBaseDir }) => {
  const matchedRoute = matchedRouteSymbols.get(moduleBaseDir)
  const captureLegacyMatch = matchedRoute === undefined
  const { wrapLayerRequest, wrapLayerError } = createLayerDispatchWrappers('router', matchedRoute, captureLegacyMatch)

  // `handleRequest` carries two concerns: the middleware dispatch span and the
  // param-start publish (`wrapHandleRequest`). Wrap the dispatch first so it
  // sits inner and param-start still fires before `middleware:enter`, matching
  // the order from when the handle itself was wrapped.
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
        // eslint-disable-next-line no-restricted-syntax -- arbitrary param names; publishing {} sets a WAF address
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
