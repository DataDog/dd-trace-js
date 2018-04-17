'use strict'

const opentracing = require('opentracing')
const Tags = opentracing.Tags
const FORMAT_HTTP_HEADERS = opentracing.FORMAT_HTTP_HEADERS
const shimmer = require('shimmer')
const METHODS = require('methods').concat('use', 'route', 'param', 'all')

const OPERATION_NAME = 'express.request'

function patch (express, tracer) {
  METHODS.forEach((method) => {
    shimmer.wrap(express.application, method, wrapper)
  })

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

        if (req.route && req.route.path) {
          span.setTag('resource.name', req.route.path)
        }

        span.setTag('service.name', tracer._service)
        span.setTag('span.type', 'web')
        span.setTag(Tags.HTTP_STATUS_CODE, res.statusCode)

        span.finish()

        return returned
      }

      return next()
    })
  }

  function wrapper (original) {
    return function () {
      if (!this._datadog_trace_patched && !this._router) {
        this._datadog_trace_patched = true
        this.use(middleware)
      }
      return original.apply(this, arguments)
    }
  }
}

function unpatch (express) {
  METHODS.forEach((method) => {
    shimmer.unwrap(express.application, method)
  })
}

module.exports = {
  name: 'express',
  versions: ['4.x'],
  patch,
  unpatch
}
