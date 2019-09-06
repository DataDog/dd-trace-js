'use strict'

const web = require('../../dd-trace/src/plugins/util/web')

function createWrapRebuild () {
  return function wrapRebuild (rebuild) {
    return function rebuildWithTrace (event) {
      rebuild.apply(this, arguments)

      this._cycle = this._cycle.map(wrapMiddleware)
    }
  }
}

function createWrapLifecycle () {
  return function wrapLifecycle (lifecycle) {
    return function lifecycleWithTrace () {
      return lifecycle.apply(this, arguments).map(wrapMiddleware)
    }
  }
}

function wrapMiddleware (middleware) {
  if (typeof middleware !== 'function') return middleware

  return function (request, next) {
    return web.reactivate(request.raw.req, () => middleware.apply(this, arguments))
  }
}

module.exports = [
  {
    name: '@hapi/hapi',
    versions: ['>=17.9'],
    file: 'lib/route.js',
    patch (Route, tracer, config) {
      this.wrap(Route.prototype, 'rebuild', createWrapRebuild(tracer, config))
    },
    unpatch (Route) {
      this.unwrap(Route.prototype, 'rebuild')
    }
  },
  {
    name: 'hapi',
    versions: ['>=10.4'],
    file: 'lib/route.js',
    patch (Route, tracer, config) {
      this.wrap(Route.prototype, 'rebuild', createWrapRebuild(tracer, config))
    },
    unpatch (Route) {
      this.unwrap(Route.prototype, 'rebuild')
    }
  },
  {
    name: 'hapi',
    versions: ['2 - 10.3'],
    file: 'lib/route.js',
    patch (Route, tracer, config) {
      this.wrap(Route.prototype, 'lifecycle', createWrapLifecycle(tracer, config))
    },
    unpatch (Route) {
      this.unwrap(Route.prototype, 'lifecycle')
    }
  }
]
