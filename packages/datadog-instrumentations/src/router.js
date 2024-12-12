'use strict'

const METHODS = require('http').METHODS.map(v => v.toLowerCase()).concat('all')
const pathToRegExp = require('path-to-regexp')
const shimmer = require('../../datadog-shimmer')
const { addHook, channel } = require('./helpers/instrument')

function createWrapRouterMethod (name) {
  const enterChannel = channel(`apm:${name}:middleware:enter`)
  const exitChannel = channel(`apm:${name}:middleware:exit`)
  const finishChannel = channel(`apm:${name}:middleware:finish`)
  const errorChannel = channel(`apm:${name}:middleware:error`)
  const nextChannel = channel(`apm:${name}:middleware:next`)

  const layerMatchers = new WeakMap()
  const regexpCache = Object.create(null)

  function wrapLayerHandle (layer, original) {
    original._name = original._name || layer.name

    const handle = shimmer.wrapFunction(original, original => function () {
      if (!enterChannel.hasSubscribers) return original.apply(this, arguments)

      const matchers = layerMatchers.get(layer)
      const lastIndex = arguments.length - 1
      const name = original._name || original.name
      const req = arguments[arguments.length > 3 ? 1 : 0]
      const next = arguments[lastIndex]

      if (typeof next === 'function') {
        arguments[lastIndex] = wrapNext(req, next)
      }

      let route

      if (matchers) {
        // Try to guess which path actually matched
        for (let i = 0; i < matchers.length; i++) {
          if (matchers[i].test(layer)) {
            route = matchers[i].path

            break
          }
        }
      }

      enterChannel.publish({ name, req, route })

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

    // This is a workaround for the `loopback` library so that it can find the correct express layer
    // that contains the real handle function
    handle._datadog_orig = original

    return handle
  }

  function wrapStack (stack, offset, matchers) {
    [].concat(stack).slice(offset).forEach(layer => {
      if (layer.__handle) { // express-async-errors
        layer.__handle = wrapLayerHandle(layer, layer.__handle)
      } else {
        layer.handle = wrapLayerHandle(layer, layer.handle)
      }

      layerMatchers.set(layer, matchers)

      if (layer.route) {
        METHODS.forEach(method => {
          if (typeof layer.route.stack === 'function') {
            layer.route.stack = [{ handle: layer.route.stack }]
          }

          layer.route[method] = wrapMethod(layer.route[method])
        })
      }
    })
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
    const arg = flatten([].concat(fn))

    if (typeof arg[0] === 'function') {
      return []
    }

    return arg.map(pattern => ({
      path: pattern instanceof RegExp ? `(${pattern})` : pattern,
      test: layer => {
        const matchers = layerMatchers.get(layer)
        return !isFastStar(layer, matchers) &&
          !isFastSlash(layer, matchers) &&
          cachedPathToRegExp(pattern).test(layer.path)
      }
    }))
  }

  function isFastStar (layer, matchers) {
    if (layer.regexp?.fast_star !== undefined) {
      return layer.regexp.fast_star
    }

    return matchers.some(matcher => matcher.path === '*')
  }

  function isFastSlash (layer, matchers) {
    if (layer.regexp?.fast_slash !== undefined) {
      return layer.regexp.fast_slash
    }

    return matchers.some(matcher => matcher.path === '/')
  }

  function flatten (arr) {
    return arr.reduce((acc, val) => Array.isArray(val) ? acc.concat(flatten(val)) : acc.concat(val), [])
  }

  function cachedPathToRegExp (pattern) {
    const maybeCached = regexpCache[pattern]
    if (maybeCached) {
      return maybeCached
    }
    const regexp = pathToRegExp(pattern)
    regexpCache[pattern] = regexp
    return regexp
  }

  function wrapMethod (original) {
    return shimmer.wrapFunction(original, original => function methodWithTrace (fn) {
      const offset = this.stack ? [].concat(this.stack).length : 0
      const router = original.apply(this, arguments)

      if (typeof this.stack === 'function') {
        this.stack = [{ handle: this.stack }]
      }

      wrapStack(this.stack, offset, extractMatchers(fn))

      return router
    })
  }

  return wrapMethod
}

const wrapRouterMethod = createWrapRouterMethod('router')

addHook({ name: 'router', versions: ['>=1 <2'] }, Router => {
  shimmer.wrap(Router.prototype, 'use', wrapRouterMethod)
  shimmer.wrap(Router.prototype, 'route', wrapRouterMethod)

  return Router
})

const queryParserReadCh = channel('datadog:query:read:finish')

addHook({ name: 'router', versions: ['>=2'] }, Router => {
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
    if (routerParamStartCh.hasSubscribers && Object.keys(req.params).length && !visitedParams.has(req.params)) {
      visitedParams.add(req.params)

      const abortController = new AbortController()

      routerParamStartCh.publish({
        req,
        res,
        params: req?.params,
        abortController
      })

      if (abortController.signal.aborted) return
    }

    return original.apply(this, arguments)
  }
}

addHook({
  name: 'router', file: 'lib/layer.js', versions: ['>=2']
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
            abortController
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
  name: 'router', versions: ['>=2']
}, router => {
  shimmer.wrap(router.prototype, 'param', wrapParam)
  return router
})

module.exports = { createWrapRouterMethod }
