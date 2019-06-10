'use strict'

const web = require('./util/web')

const traceRoute = handler => req => {
  const { original, route } = req

  if (web.active(original)) {
    web.enterRoute(original, route)
  }

  return handler(req)
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
  this.wrap(paperplane, 'mount', wrapMount(tracer, config))
  this.wrap(paperplane, 'routes', wrapRoutes(tracer))
}

function unpatch (paperplane) {
  this.unwrap(paperplane, ['mount', 'routes'])
}

module.exports = {
  name: 'paperplane',
  versions: ['>=2.3'],
  patch,
  unpatch
}
