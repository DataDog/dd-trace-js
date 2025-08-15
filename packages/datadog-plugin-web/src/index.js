'use strict'

const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const {
  ERROR_MESSAGE,
  ERROR_TYPE,
  ERROR_STACK
} = require('../../dd-trace/src/constants')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const InferredProxyPlugin = require('../../datadog-plugin-inferred-proxy/src')
const web = require('./utils')
const tags = require('../../../ext/tags')
const types = require('../../../ext/types')
const kinds = require('../../../ext/kinds')

const {
  contexts,
  ends,
  normalizeConfig,
  setRoute,
  patch,
  root,
  getContext,
  addError,
  finishSpan,
  addAllowHeaders,
  isOriginAllowed,
  reactivate,
} = web

const WEB = types.WEB
const SERVER = kinds.SERVER
const RESOURCE_NAME = tags.RESOURCE_NAME
const MANUAL_DROP = tags.MANUAL_DROP
const SERVICE_NAME = tags.SERVICE_NAME
const FORMAT_HTTP_HEADERS = 'http_headers'

class WebPlugin extends TracingPlugin {
  static id = WEB
  static kind = SERVER
  static type = WEB

  constructor (tracer, config, bindError = true) {
    super(tracer, config)
    this.addSub('apm:http:server:request:error', ({ req, error }) => {
      if (error) {
        this.addError(req, error)
      }
    })

    this.addSub('apm:http:server:request:end', ({ req }) => {
      this.finish(req)
    })

    this.addSub(`apm:${this.constructor.id}:request:handle`, ({ req }) => {
      this.setFramework(req, this.constructor.framework || this.constructor.id)
    })

    this.addSub(`apm:${this.constructor.id}:request:route`, ({ req, route }) => {
      this.setRoute(req, route)
    })

    if (bindError) {
      this.addSub(`apm:${this.constructor.id}:request:error`, ({ req, error }) => {
        this.addError(req, error)
      })
    }

    this.configure(config)
  }

  configure (config) {
    return super.configure(this.normalizeConfig(config))
  }

  // Ensure the configuration has the correct structure and defaults.
  normalizeConfig (config) {
    return normalizeConfig(config)
  }

  setFramework (req, name) {
    const context = this.patch(req)
    const span = context.span

    if (!span) return

    span.context()._name = `${name}.request`
    span.context()._tags.component = name
    span._integrationName = name

    this.setConfig(req)
  }

  setConfig (req) {
    const context = contexts.get(req)
    if (!context) return

    context.config = this.config

    const span = context.span
    if (!span) return

    if (!context.config.filter(req.url)) {
      span.setTag(MANUAL_DROP, true)
      span.context()._trace.isRecording = false
    }

    if (context.config.service) {
      span.setTag(SERVICE_NAME, context.config.service)
    }

    analyticsSampler.sample(span, context.config.measured, true)
  }

  startSpan (req, res, name, traceCtx) {
    const context = this.patch(req)

    let span

    if (context.span) {
      context.span.context()._name = name
      span = context.span
    } else {
      span = this.startChildSpan(name, req, traceCtx)
    }

    context.tracer = this.tracer
    context.span = span
    context.res = res

    this.setConfig(req)
    web._addRequestTags(context)

    return span
  }

  wrap (req) {
    const context = contexts.get(req)
    if (!context.instrumented) {
      this.wrapEnd(context)
      context.instrumented = true
    }
  }

  // Start a span and activate a scope for a request.
  instrument (req, res, name, callback) {
    const span = this.startSpan(req, res, name)

    this.wrap(req)

    return callback && this.tracer.scope().activate(span, () => callback(span))
  }

  // Reactivate the request scope in case it was changed by a middleware.
  reactivate (req, fn) {
    return reactivate(req, fn)
  }

  // Add a route segment that will be used for the resource name.
  enterRoute (req, path) {
    if (typeof path === 'string') {
      contexts.get(req).paths.push(path)
    }
  }

  setRoute (req, path) {
    setRoute(req, path)
  }

  // Remove the current route segment.
  exitRoute (req) {
    contexts.get(req).paths.pop()
  }

  // Start a new middleware span and activate a new scope with the span.
  wrapMiddleware (req, middleware, name, fn) {
    if (!this.active(req)) return fn()

    const context = contexts.get(req)
    const tracer = context.tracer
    const childOf = this.active(req)
    const config = context.config
    const traceCtx = context.traceCtx

    if (config.middleware === false) return this.bindAndWrapMiddlewareErrors(fn, req, tracer, childOf)

    const span = super.startSpan(name, {
      childOf
    }, traceCtx)

    analyticsSampler.sample(span, config.measured)

    span.addTags({
      [RESOURCE_NAME]: middleware._name || middleware.name || '<anonymous>'
    })

    context.middleware.push(span)

    return tracer.scope().activate(span, fn)
  }

  // catch errors and apply to active span
  bindAndWrapMiddlewareErrors (fn, req, tracer, activeSpan) {
    try {
      return tracer.scope().bind(fn, activeSpan).apply(this, arguments)
    } catch (e) {
      this.addError(req, e) // TODO: remove when error formatting is moved to Span
      throw e
    }
  }

  // Finish the active middleware span.
  finish (req, error) {
    if (!this.active(req)) return

    const context = contexts.get(req)
    const span = context.middleware.pop()

    if (span) {
      if (error) {
        span.addTags({
          [ERROR_TYPE]: error.name,
          [ERROR_MESSAGE]: error.message,
          [ERROR_STACK]: error.stack
        })
      }

      span.finish()
    }
  }

  // Register a callback to run before res.end() is called.
  beforeEnd (req, callback) {
    contexts.get(req).beforeEnd.push(callback)
  }

  patch (req) {
    return patch(req, this.config)
  }

  // Return the request root span.
  root (req) {
    return root(req)
  }

  // Return the active span.
  active (req) {
    const context = contexts.get(req)

    if (!context) return null
    if (context.middleware.length === 0) return context.span || null

    return context.middleware.at(-1)
  }

  // Extract the parent span from the headers and start a new span as its child
  startChildSpan (name, req, traceCtx) {
    const headers = req.headers
    const reqCtx = this.getContext(req)
    let childOf = this.tracer.extract(FORMAT_HTTP_HEADERS, headers)

    InferredProxyPlugin.maybeCreateInferredProxySpan(this._tracerConfig, req, reqCtx, childOf, traceCtx)
    if (reqCtx.inferredProxySpan) {
      childOf = reqCtx.inferredProxySpan
    }

    const span = super.startSpan(name, {
      childOf,
      kind: this.constructor.kind,
      type: this.constructor.type
    }, traceCtx)

    return span
  }

  // Add an error to the request
  addError (req, error) {
    addError(req, error)
  }

  finishMiddleware (context) {
    if (context.finished) return

    let span

    while ((span = context.middleware.pop())) {
      span.finish()
    }
  }

  finishSpan (context) {
    finishSpan(context)
  }

  finishAll (context) {
    for (const beforeEnd of context.beforeEnd) {
      beforeEnd()
    }

    this.finishMiddleware(context)

    this.finishSpan(context)

    InferredProxyPlugin.finishInferredProxySpan(context)
  }

  wrapWriteHead (context) {
    const {
      req,
      res
    } = context
    const writeHead = res.writeHead

    return function (statusCode, statusMessage, headers) {
      headers = typeof statusMessage === 'string' ? headers : statusMessage
      headers = Object.assign(res.getHeaders(), headers)

      if (req.method.toLowerCase() === 'options' && isOriginAllowed(req, headers)) {
        addAllowHeaders(req, res, headers)
      }

      return writeHead.apply(this, arguments)
    }
  }

  getContext (req) {
    return getContext(req)
  }

  wrapRes (context, req, res, end) {
    return () => {
      this.finishAll(context)

      return end.apply(res, arguments)
    }
  }

  wrapEnd (context) {
    const scope = context.tracer.scope()
    const req = context.req
    const res = context.res
    const end = res.end

    res.writeHead = this.wrapWriteHead(context)

    ends.set(res, this.wrapRes(context, req, res, end))

    Object.defineProperty(res, 'end', {
      configurable: true,
      get () {
        return ends.get(this)
      },
      set (value) {
        ends.set(this, scope.bind(value, context.span))
      }
    })
  }
}

module.exports = WebPlugin
module.exports.static = web
