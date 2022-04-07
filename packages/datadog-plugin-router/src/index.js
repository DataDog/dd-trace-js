'use strict'

const METHODS = require('methods').concat('all')
const pathToRegExp = require('path-to-regexp')
const shimmer = require('../../datadog-shimmer')
const web = require('../../dd-trace/src/plugins/util/web')

// TODO: stop checking for fast star and fast slash

const contexts = new WeakMap()
const layerMatchers = new WeakMap()
const regexpCache = Object.create(null)

function createWrapHandle (tracer, config) {
  return function wrapHandle (handle) {
    return function handleWithTrace (req, res, done) {
      web.patch(req)

      if (!contexts.has(req)) {
        const context = {
          route: '',
          stack: []
        }

        web.beforeEnd(req, () => {
          web.enterRoute(req, context.route)
        })

        contexts.set(req, context)
      }

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

function wrapNext (layer, req, next) {
  if (!next || !web.active(req)) return next

  const originalNext = next
  const context = contexts.get(req)
  const matchers = layerMatchers.get(layer)

  return function (error) {
    if (layer.path && !isFastStar(layer, matchers) && !isFastSlash(layer, matchers)) {
      context.stack.pop()
    }

    web.finish(req, error)

    originalNext.apply(null, arguments)
  }
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
