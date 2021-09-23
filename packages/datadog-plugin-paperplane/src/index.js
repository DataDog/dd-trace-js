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

const nodeMajor = Number(process.versions.node.split('.')[0])
const mainVersionRange = nodeMajor <= 12 ? ['>=2.3.2'] : nodeMajor <= 14 ? ['>=3.1.1'] : []

module.exports = [
  {
    name: 'paperplane',
    versions: mainVersionRange,
    file: 'lib/logger.js',
    patch (exports, tracer) {
      if (tracer._logInjection) {
        this.wrap(exports, 'logger', wrapLogger(tracer))
      }
    },
    unpatch (exports) {
      this.unwrap(exports, 'logger')
    }
  },
  {
    name: 'paperplane',
    versions: mainVersionRange,
    file: 'lib/mount.js',
    patch (exports, tracer, config) {
      config = web.normalizeConfig(config)
      this.wrap(exports, 'mount', wrapMount(tracer, config))
    },
    unpatch (exports) {
      this.unwrap(exports, 'mount')
    }
  },
  {
    name: 'paperplane',
    versions: mainVersionRange,
    file: 'lib/routes.js',
    patch (exports, tracer) {
      this.wrap(exports, 'routes', wrapRoutes(tracer))
    },
    unpatch (exports) {
      this.unwrap(exports, 'routes')
    }
  }
]

if (nodeMajor <= 12) {
  module.exports.push({
    name: 'paperplane',
    versions: ['2.3.0 - 2.3.1'],
    patch (paperplane, tracer, config) {
      config = web.normalizeConfig(config)
      this.wrap(paperplane, 'mount', wrapMount(tracer, config))
      this.wrap(paperplane, 'routes', wrapRoutes(tracer))
    },
    unpatch (paperplane) {
      this.unwrap(paperplane, ['mount', 'routes'])
    }
  })
}
