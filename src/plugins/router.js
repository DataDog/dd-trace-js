'use strict'

const METHODS = require('methods').concat('all')
const pathToRegExp = require('path-to-regexp')
const web = require('./util/web')

function createWrapHandle (tracer, config) {
  return function wrapHandle (handle) {
    return function handleWithTracer (req) {
      web.patch(req)

      return handle.apply(this, arguments)
    }
  }
}

function createWrapProcessParams (tracer, config) {
  return function wrapProcessParams (processParams) {
    return function processParamsWithTrace (layer, called, req, res, done) {
      const matchers = layer._datadog_matchers

      req = done ? req : called

      if (web.active(req) && matchers) {
        // Try to guess which path actually matched
        for (let i = 0; i < matchers.length; i++) {
          if (matchers[i].test(layer.path)) {
            web.enterRoute(req, matchers[i].path)

            break
          }
        }
      }

      return processParams.apply(this, arguments)
    }
  }
}

function wrapRouterMethod (original) {
  return function methodWithTrace (fn) {
    const offset = this.stack ? [].concat(this.stack).length : 0
    const router = original.apply(this, arguments)

    if (this.stack) {
      wrapStack(this.stack, offset, extractMatchers(fn))
    }

    return router
  }
}

function wrapStack (stack, offset, matchers) {
  [].concat(stack).slice(offset).forEach(layer => {
    const handle = layer.handle || layer

    if (handle.length === 4) {
      layer.handle = (error, req, res, next) => {
        return handle.call(layer, error, req, res, wrapNext(layer, req, next))
      }
    } else {
      layer.handle = (req, res, next) => {
        return handle.call(layer, req, res, wrapNext(layer, req, next))
      }
    }

    layer._datadog_matchers = matchers

    if (layer.route) {
      METHODS.forEach(method => {
        layer.route[method] = wrapRouterMethod(layer.route[method])
      })
    }
  })
}

function wrapNext (layer, req, next) {
  if (!web.active(req)) {
    return next
  }

  const originalNext = next

  web.reactivate(req)

  return function (error) {
    if (!error && layer.path && !isFastStar(layer)) {
      web.exitRoute(req)
    }

    process.nextTick(() => {
      originalNext.apply(null, arguments)
    })
  }
}

function extractMatchers (fn) {
  const arg = flatten([].concat(fn))

  if (typeof arg[0] === 'function') {
    return []
  }

  return arg.map(pattern => ({
    path: pattern instanceof RegExp ? `(${pattern})` : pattern,
    test: path => pathToRegExp(pattern).test(path)
  }))
}

function isFastStar (layer) {
  if (layer.regexp.fast_star !== undefined) {
    return layer.regexp.fast_star
  }

  return layer._datadog_matchers.some(matcher => matcher.path === '*')
}

function flatten (arr) {
  return arr.reduce((acc, val) => Array.isArray(val) ? acc.concat(flatten(val)) : acc.concat(val), [])
}

module.exports = {
  name: 'router',
  versions: ['1.x'],
  patch (Router, tracer, config) {
    this.wrap(Router.prototype, 'handle', createWrapHandle(tracer, config))
    this.wrap(Router.prototype, 'process_params', createWrapProcessParams(tracer, config))
    this.wrap(Router.prototype, 'use', wrapRouterMethod)
    this.wrap(Router.prototype, 'route', wrapRouterMethod)
  },
  unpatch (Router) {
    this.unwrap(Router.prototype, 'handle')
    this.unwrap(Router.prototype, 'process_params')
    this.unwrap(Router.prototype, 'use')
    this.unwrap(Router.prototype, 'route')
  }
}
