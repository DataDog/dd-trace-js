'use strict'

const METHODS = require('methods').concat('all')
const pathToRegExp = require('path-to-regexp')
const web = require('../../dd-trace/src/plugins/util/web')

const regexpCache = Object.create(null)

function createWrapHandle (tracer, config) {
  return function wrapHandle (handle) {
    return function handleWithTracer (req, res, done) {
      web.patch(req)

      return handle.apply(this, arguments)
    }
  }
}

function wrapRouterMethod (original) {
  return function methodWithTrace (fn) {
    const offset = this.stack ? [].concat(this.stack).length : 0
    const router = original.apply(this, arguments)

    if (typeof this.stack === 'function') {
      this.stack = [{ handle: this.stack }]
    }

    wrapStack(this.stack, offset, extractMatchers(fn))

    return router
  }
}

function wrapLayerHandle (layer, handle) {
  handle._name = handle._name || layer.name

  let wrapCallHandle

  if (handle.length === 4) {
    wrapCallHandle = function (error, req, res, next) {
      return callHandle(layer, handle, req, [error, req, res, wrapNext(layer, req, next)])
    }
  } else {
    wrapCallHandle = function (req, res, next) {
      return callHandle(layer, handle, req, [req, res, wrapNext(layer, req, next)])
    }
  }

  // This is a workaround for the `loopback` library so that it can find the correct express layer
  // that contains the real handle function
  wrapCallHandle._datadog_orig = handle

  // TODO(bengl) assigning prototypes like this when wrapping should be done in a centralized place.
  Object.setPrototypeOf(wrapCallHandle, handle)

  return wrapCallHandle
}

function wrapStack (stack, offset, matchers) {
  [].concat(stack).slice(offset).forEach(layer => {
    if (layer.__handle) { // express-async-errors
      layer.__handle = wrapLayerHandle(layer, layer.__handle)
    } else {
      layer.handle = wrapLayerHandle(layer, layer.handle)
    }

    layer._datadog_matchers = matchers

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

function wrapNext (layer, req, next) {
  if (!next || !web.active(req)) return next

  const originalNext = next

  return function (error) {
    if (!error && layer.path && !isFastStar(layer) && !isFastSlash(layer)) {
      web.exitRoute(req)
    }

    web.finish(req, error)

    originalNext.apply(null, arguments)
  }
}

function callHandle (layer, handle, req, args) {
  const matchers = layer._datadog_matchers

  if (web.active(req) && matchers) {
    // Try to guess which path actually matched
    for (let i = 0; i < matchers.length; i++) {
      if (matchers[i].test(layer)) {
        web.enterRoute(req, matchers[i].path)

        break
      }
    }
  }

  return web.wrapMiddleware(req, handle, 'express.middleware', () => {
    return handle.apply(layer, args)
  })
}

function extractMatchers (fn) {
  const arg = flatten([].concat(fn))

  if (typeof arg[0] === 'function') {
    return []
  }

  return arg.map(pattern => ({
    path: pattern instanceof RegExp ? `(${pattern})` : pattern,
    test: layer => !isFastStar(layer) && !isFastSlash(layer) && cachedPathToRegExp(pattern).test(layer.path)
  }))
}

function isFastStar (layer) {
  if (layer.regexp.fast_star !== undefined) {
    return layer.regexp.fast_star
  }

  return layer._datadog_matchers.some(matcher => matcher.path === '*')
}

function isFastSlash (layer) {
  if (layer.regexp.fast_slash !== undefined) {
    return layer.regexp.fast_slash
  }

  return layer._datadog_matchers.some(matcher => matcher.path === '/')
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

module.exports = {
  name: 'router',
  versions: ['>=1'],
  patch (Router, tracer, config) {
    this.wrap(Router.prototype, 'handle', createWrapHandle(tracer, config))
    this.wrap(Router.prototype, 'use', wrapRouterMethod)
    this.wrap(Router.prototype, 'route', wrapRouterMethod)
  },
  unpatch (Router) {
    this.unwrap(Router.prototype, 'handle')
    this.unwrap(Router.prototype, 'use')
    this.unwrap(Router.prototype, 'route')
  }
}
