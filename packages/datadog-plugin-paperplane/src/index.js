'use strict'

const web = require('../../dd-trace/src/plugins/util/web')

const traceRoute = handler => req => {
  const { original, route } = req

  if (web.active(original)) {
    web.enterRoute(original, route)
  }

  return handler(req)
}

const wrapLogger = tracer => logger => record => {
  const span = tracer.scope().active()

  if (!span) return logger(record)

  const correlation = {
    dd: {
      trace_id: span.context().toTraceId(),
      span_id: span.context().toSpanId()
    }
  }

  record = record instanceof Error
    ? Object.assign(record, correlation)
    : Object.assign({}, record, correlation)

  return logger(record)
}

const wrapMount = (tracer, config) => mount => opts => {
  const handler = mount(opts)

  const traced = (req, res) =>
    web.instrument(
      tracer, config, req, res, 'paperplane.request',
      () => handler(req, res)
    )

  return traced
}

const wrapRoutes = tracer => routes => handlers => {
  const traced = {}

  for (const route in handlers) {
    traced[route] = traceRoute(handlers[route])
  }

  return routes(traced)
}

function patch (paperplane, tracer, config) {
  config = web.normalizeConfig(config)

  if (tracer._logInjection) {
    this.wrap(paperplane, 'logger', wrapLogger(tracer))
  }

  this.wrap(paperplane, 'mount', wrapMount(tracer, config))
  this.wrap(paperplane, 'routes', wrapRoutes(tracer))
}

function unpatch (paperplane) {
  this.unwrap(paperplane, ['logger', 'mount', 'routes'])
}

module.exports = {
  name: 'paperplane',
  versions: ['>=2.3.1'],
  patch,
  unpatch
}
