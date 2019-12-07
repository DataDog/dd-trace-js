'use strict'

const web = require('../../dd-trace/src/plugins/util/web')

function createWrapConnect (tracer, config) {
  return function wrapConnect (connect) {
    if (typeof connect !== 'function') return connect

    const connectWithTrace = function connectWithTrace () {
      return connect._datadog_wrapper.apply(this, arguments)
    }

    connect._datadog_wrapper = function () {
      const app = connect()

      if (!app) return app

      app.use = createWrapUse(config)(app.use)
      app.handle = createWrapHandle(tracer, config)(app.handle)

      return app
    }

    return connectWithTrace
  }
}

function createWrapUse (config) {
  config = web.normalizeConfig(config)

  return function wrapUse (use) {
    if (typeof use !== 'function') return use

    return function useWithTrace (route, fn) {
      const result = use.apply(this, arguments)

      if (!this || !Array.isArray(this.stack)) return result

      const index = this.stack.length - 1
      const layer = this.stack[index]

      if (layer && layer.handle) {
        this.stack[index].handle = wrapLayerHandle(layer, config)
      }

      return result
    }
  }
}

function createWrapHandle (tracer, config) {
  config = web.normalizeConfig(config)

  return function wrapHandle (handle) {
    if (typeof handle !== 'function') return handle

    return function handleWithTrace (req, res, out) {
      return web.instrument(tracer, config, req, res, 'connect.request', () => {
        return handle.apply(this, arguments)
      })
    }
  }
}

function unwrapConnect (connect) {
  connect._datadog_wrapper = connect
}

function wrapLayerHandle (layer, config) {
  if (typeof layer.handle !== 'function') return layer.handle

  const handle = layer.handle

  if (layer.handle.length === 4) {
    return function (error, req, res, next) {
      return callLayerHandle(layer, handle, req, config, [error, req, res, wrapNext(layer, req, next)])
    }
  } else {
    return function (req, res, next) {
      return callLayerHandle(layer, handle, req, config, [req, res, wrapNext(layer, req, next)])
    }
  }
}

function callLayerHandle (layer, handle, req, config, args) {
  const route = layer.route

  if (route !== '/') {
    web.enterRoute(req, route)
  }

  return web.wrapMiddleware(req, handle, config, 'connect.middleware', () => {
    return handle.apply(layer, args)
  })
}

function wrapNext (layer, req, next) {
  if (typeof next !== 'function' || !web.active(req)) return next

  return function nextWithTrace (error) {
    if (!error && layer.route !== '/') {
      web.exitRoute(req)
    }

    web.finish(req, error)

    next.apply(this, arguments)
  }
}

module.exports = [
  {
    name: 'connect',
    versions: ['>=3'],
    patch (connect, tracer, config) {
      // `connect` is a function so we return a wrapper that will replace its export.
      return createWrapConnect(tracer, config)(connect)
    },
    unpatch (connect) {
      unwrapConnect(connect)
    }
  },
  {
    name: 'connect',
    versions: ['2.2.2'],
    patch (connect, tracer, config) {
      this.wrap(connect.proto, 'use', createWrapUse(config))
      this.wrap(connect.proto, 'handle', createWrapHandle(tracer, config))
    },
    unpatch (connect) {
      this.unwrap(connect.proto, 'use')
      this.unwrap(connect.proto, 'handle')
    }
  }
]
