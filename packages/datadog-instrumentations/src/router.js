'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const pathToRegExp = require('path-to-regexp')
const METHODS = require('methods').concat('all')
const web = require('../../dd-trace/src/plugins/util/web')

const startCh = channel('apm:router:middleware:start')
const enterCh = channel('apm:router:middleware:enter')
const finish = channel('apm:router:middleware:finish')
const errorCh = channel('apm:router:middleware:error')

const contexts = new WeakMap()
const layerMatchers = new WeakMap()
const regexpCache = Object.create(null)

const protoHandler = function (prototype) {
  shimmer.wrap(prototype, 'handle', handle => function (req, res, done) {
    if (!contexts.has(req)) {
      const context = {
        route: '',
        stack: []
      }
      enterCh.publish({ req, context })
      contexts.set(req, context)
    } else {
      enterCh.publish({ req })
    }

    return handle.apply(this, arguments)
  })

  shimmer.wrap(prototype, 'use', wrapRouterMethod)

  shimmer.wrap(prototype, 'route', wrapRouterMethod)
  return prototype
}

addHook({ name: 'router', versions: ['>=1'] }, Router => {
  protoHandler(Router.prototype)
  return Router
})

function wrapRouterMethod (original) {
  return function (fn) {
    const offset = this.stack ? [].concat(this.stack).length : 0
    const router = original.apply(this, arguments)

    if (typeof this.stack === 'function') {
      this.stack = [{ handle: this.stack }]
    }

    wrapStack(this.stack, offset, extractMatchers(fn))

    return router
  }
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
  if (layer.regexp.fast_star !== undefined) {
    return layer.regexp.fast_star
  }

  return matchers.some(matcher => matcher.path === '*')
}

function isFastSlash (layer, matchers) {
  if (layer.regexp.fast_slash !== undefined) {
    return layer.regexp.fast_slash
  }

  return matchers.some(matcher => matcher.path === '/')
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

function flatten (arr) {
  return arr.reduce((acc, val) => Array.isArray(val) ? acc.concat(flatten(val)) : acc.concat(val), [])
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

        layer.route[method] = wrapRouterMethod(layer.route[method])
      })
    }
  })
}

function wrapLayerHandle (layer, handle) {
  handle._name = handle._name || layer.name

  let wrapCallHandle

  if (handle.length === 4) {
    wrapCallHandle = shimmer.wrap(handle, function (error, req, res, next) {
      return callHandle(layer, handle, req, [error, req, res, wrapNext(layer, req, next)])
    })
  } else {
    wrapCallHandle = shimmer.wrap(handle, function (req, res, next) {
      return callHandle(layer, handle, req, [req, res, wrapNext(layer, req, next)])
    })
  }

  // This is a workaround for the `loopback` library so that it can find the correct express layer
  // that contains the real handle function
  wrapCallHandle._datadog_orig = handle

  return wrapCallHandle
}

function callHandle (layer, handle, req, args) {
  const matchers = layerMatchers.get(layer)
  if (web.active(req) && matchers) {
    // Try to guess which path actually matched
    for (let i = 0; i < matchers.length; i++) {
      if (matchers[i].test(layer)) {
        const context = contexts.get(req)

        context.stack.push(matchers[i].path)

        const route = context.stack.join('')

        // Longer route is more likely to be the actual route handler route.
        if (route.length > context.route.length) {
          context.route = route
        }

        break
      }
    }
  }
  const asyncResource = new AsyncResource('bound-anonymous-fn')

  args[args.length - 1] = asyncResource.bind(args[args.length - 1])

  return asyncResource.runInAsyncScope(() => {
    startCh.publish({ req, handle })
    try {
      return handle.apply(layer, args)
    } catch (error) {
      errorCh.publish({ error })

      throw error
    }
  })
}

function wrapNext (layer, req, next) {
  if (!next || !web.active(req)) return next

  const originalNext = AsyncResource.bind(next)
  const context = contexts.get(req)
  const matchers = layerMatchers.get(layer)

  return function (error) {
    if (layer.path && !isFastStar(layer, matchers) && !isFastSlash(layer, matchers)) {
      context.stack.pop()
    }

    finish.publish({ req, error })

    originalNext.apply(null, arguments)
  }
}

module.exports = protoHandler
