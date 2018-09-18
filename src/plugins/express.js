'use strict'

const METHODS = require('methods').concat('use', 'route', 'param', 'all')
const pathToRegExp = require('path-to-regexp')
const web = require('./util/web')

function createWrapMethod (tracer, config) {
  config = web.normalizeConfig(config)

  function ddTrace (req, res, next) {
    if (web.active(req)) return next()

    web.instrument(tracer, config, req, res, 'express.request')

    next()
  }

  return function wrapMethod (original) {
    return function methodWithTrace () {
      if (!this._datadog_trace_patched && !this._router) {
        this._datadog_trace_patched = true
        this.use(ddTrace)
      }
      return original.apply(this, arguments)
    }
  }
}

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

      if (matchers) {
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

function createWrapRouterMethod (tracer) {
  return function wrapRouterMethod (original) {
    return function methodWithTrace (fn) {
      const offset = this.stack.length
      const router = original.apply(this, arguments)
      const matchers = extractMatchers(fn)

      this.stack.slice(offset).forEach(layer => {
        const handle = layer.handle

        if (handle.length === 4) {
          layer.handle = (error, req, res, next) => {
            return handle.call(layer, error, req, res, wrapNext(tracer, layer, req, next))
          }
        } else {
          layer.handle = (req, res, next) => {
            return handle.call(layer, req, res, wrapNext(tracer, layer, req, next))
          }
        }

        layer._datadog_matchers = matchers
      })

      return router
    }
  }
}

function wrapNext (tracer, layer, req, next) {
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

function patch (express, tracer, config) {
  METHODS.forEach(method => {
    this.wrap(express.application, method, createWrapMethod(tracer, config))
  })
  this.wrap(express.Router, 'handle', createWrapHandle(tracer, config))
  this.wrap(express.Router, 'process_params', createWrapProcessParams(tracer, config))
  this.wrap(express.Router, 'use', createWrapRouterMethod(tracer, config))
  this.wrap(express.Router, 'route', createWrapRouterMethod(tracer, config))
}

function unpatch (express) {
  METHODS.forEach(method => this.unwrap(express.application, method))
  this.unwrap(express.Router, 'handle')
  this.unwrap(express.Router, 'process_params')
  this.unwrap(express.Router, 'use')
  this.unwrap(express.Router, 'route')
}

module.exports = {
  name: 'express',
  versions: ['4.x'],
  patch,
  unpatch
}
