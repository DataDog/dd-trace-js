'use strict'

const opentracing = require('opentracing')
const Tags = opentracing.Tags
const FORMAT_HTTP_HEADERS = opentracing.FORMAT_HTTP_HEADERS
const shimmer = require('shimmer')
const METHODS = require('methods').concat('use', 'route', 'param', 'all')
const pathToRegExp = require('path-to-regexp')

const OPERATION_NAME = 'express.request'

function createWrapMethod (tracer, config) {
  function middleware (req, res, next) {
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`
    const childOf = tracer.extract(FORMAT_HTTP_HEADERS, req.headers)

    tracer.trace(OPERATION_NAME, {
      childOf,
      tags: {
        [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_SERVER,
        [Tags.HTTP_URL]: url,
        [Tags.HTTP_METHOD]: req.method
      }
    }, span => {
      const originalEnd = res.end

      res.end = function () {
        res.end = originalEnd
        const returned = res.end.apply(this, arguments)
        const paths = tracer._context.get('express.paths')

        if (paths) {
          span.setTag('resource.name', paths.join(''))
        }

        span.setTag('service.name', config.service || tracer._service)
        span.setTag('span.type', 'web')
        span.setTag(Tags.HTTP_STATUS_CODE, res.statusCode)

        span.finish()

        return returned
      }

      req._datadog_trace_patched = true

      return next()
    })
  }

  return function wrapMethod (original) {
    return function methodWithTrace () {
      if (!this._datadog_trace_patched && !this._router) {
        this._datadog_trace_patched = true
        this.use(middleware)
      }
      return original.apply(this, arguments)
    }
  }
}

function createWrapProcessParams (tracer, config) {
  const context = tracer._context

  return function wrapProcessParams (processParams) {
    return function processParamsWithTrace (layer, called, req, res, done) {
      const matchers = layer._datadog_matchers
      let paths = context.get('express.paths') || []

      if (matchers) {
        // Try to guess which path actually matched
        for (let i = 0; i < matchers.length; i++) {
          if (matchers[i].test(layer.path)) {
            paths = paths.concat(matchers[i].path)

            context.set('express.paths', paths)

            break
          }
        }
      }

      return processParams.apply(this, arguments)
    }
  }
}

function createWrapRouterMethod (tracer) {
  const context = tracer._context

  return function wrapRouterMethod (original) {
    return function methodWithTrace (fn) {
      const offset = this.stack.length
      const router = original.apply(this, arguments)
      const matchers = extractMatchers(fn)

      this.stack.slice(offset).forEach(layer => {
        const handle = layer.handle_request

        layer.handle_request = (req, res, next) => {
          if (req._datadog_trace_patched) {
            const originalNext = next

            next = context.bind(function () {
              const paths = context.get('express.paths')

              if (paths && layer.path) {
                paths.pop()
              }

              originalNext.apply(null, arguments)
            })
          }

          return handle.call(layer, req, res, next)
        }

        layer._datadog_matchers = matchers
      })

      return router
    }
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

function flatten (arr) {
  return arr.reduce((acc, val) => Array.isArray(val) ? acc.concat(flatten(val)) : acc.concat(val), [])
}

function patch (express, tracer, config) {
  METHODS.forEach(method => {
    shimmer.wrap(express.application, method, createWrapMethod(tracer, config))
  })
  shimmer.wrap(express.Router, 'process_params', createWrapProcessParams(tracer, config))
  shimmer.wrap(express.Router, 'use', createWrapRouterMethod(tracer, config))
  shimmer.wrap(express.Router, 'route', createWrapRouterMethod(tracer, config))
}

function unpatch (express) {
  METHODS.forEach(method => shimmer.unwrap(express.application, method))
  shimmer.unwrap(express.Router, 'process_params')
  shimmer.unwrap(express.Router, 'use')
  shimmer.unwrap(express.Router, 'route')
}

module.exports = {
  name: 'express',
  versions: ['4.x'],
  patch,
  unpatch
}
