'use strict'

const web = require('../../dd-trace/src/plugins/util/web')

function createWrapDispatch (tracer, config) {
  config = web.normalizeConfig(config)

  return function wrapDispatch (dispatch) {
    return function dispatchWithTrace (options) {
      const handler = dispatch.apply(this, arguments)

      if (typeof handler !== 'function') return handler

      return function (req, res) {
        return web.instrument(tracer, config, req, res, 'hapi.request', () => {
          return handler.apply(this, arguments)
        })
      }
    }
  }
}

function createWrapServer (tracer) {
  return function wrapServer (server) {
    return function serverWithTrace (options) {
      const app = server.apply(this, arguments)

      if (!app) return app

      if (typeof app.ext === 'function') {
        app.ext = createWrapExt(tracer)(app.ext)
      }

      if (typeof app.start === 'function') {
        app.start = createWrapStart(tracer)(app.start)
      }

      return app
    }
  }
}

function createWrapStart () {
  return function wrapStart (start) {
    return function startWithTrace () {
      if (this && typeof this.ext === 'function') {
        this.ext('onPreResponse', onPreResponse)
      }

      return start.apply(this, arguments)
    }
  }
}

function createWrapExt () {
  return function wrapExt (ext) {
    return function extWithTrace (events, method, options) {
      if (typeof events === 'object') {
        arguments[0] = wrapEvents(events)
      } else {
        arguments[1] = wrapExtension(method)
      }

      return ext.apply(this, arguments)
    }
  }
}

function wrapExtension (method) {
  return [].concat(method).map(wrapHandler)
}

function wrapEvents (events) {
  return [].concat(events).map(event => {
    if (!event || !event.method) return event

    return Object.assign({}, event, {
      method: wrapExtension(event.method)
    })
  })
}

function wrapHandler (handler) {
  if (typeof handler !== 'function') return handler

  return function (request, h) {
    if (!request || !request.raw) return handler.apply(this, arguments)

    return web.reactivate(request.raw.req, () => handler.apply(this, arguments))
  }
}

function onPreResponse (request, h) {
  if (!request || !request.raw) return reply(request, h)

  const req = request.raw.req

  web.addError(req, request.response)

  if (request.route) {
    web.enterRoute(req, request.route.path)
  }

  return reply(request, h)
}

function reply (request, h) {
  if (h.continue) {
    return typeof h.continue === 'function'
      ? h.continue()
      : h.continue
  } else if (typeof h === 'function') {
    return h()
  }
}

module.exports = [
  {
    name: '@hapi/hapi',
    versions: ['>=17.9'],
    patch (hapi, tracer, config) {
      this.wrap(hapi, ['server', 'Server'], createWrapServer(tracer, config))
    },
    unpatch (hapi) {
      this.unwrap(hapi, ['server', 'Server'])
    }
  },
  {
    name: 'hapi',
    versions: ['>=17'],
    patch (hapi, tracer, config) {
      this.wrap(hapi, ['server', 'Server'], createWrapServer(tracer, config))
    },
    unpatch (hapi) {
      this.unwrap(hapi, ['server', 'Server'])
    }
  },
  {
    name: 'hapi',
    versions: ['2 - 7.1', '8 - 16'],
    patch (hapi, tracer, config) {
      this.wrap(hapi.Server.prototype, 'start', createWrapStart(tracer, config))
      this.wrap(hapi.Server.prototype, 'ext', createWrapExt(tracer, config))
    },
    unpatch (hapi) {
      this.unwrap(hapi.Server.prototype, 'start')
      this.unwrap(hapi.Server.prototype, 'ext')
    }
  },
  {
    name: 'hapi',
    versions: ['^7.2'],
    patch (hapi, tracer, config) {
      this.wrap(hapi, 'createServer', createWrapServer(tracer, config))
    },
    unpatch (hapi) {
      this.unwrap(hapi, 'createServer')
    }
  },
  {
    name: '@hapi/hapi',
    versions: ['>=17.9'],
    file: 'lib/core.js',
    patch (Core, tracer, config) {
      this.wrap(Core.prototype, '_dispatch', createWrapDispatch(tracer, config))
    },
    unpatch (Core) {
      this.unwrap(Core.prototype, '_dispatch')
    }
  },
  {
    name: 'hapi',
    versions: ['7.2 - 16'],
    file: 'lib/connection.js',
    patch (Connection, tracer, config) {
      this.wrap(Connection.prototype, '_dispatch', createWrapDispatch(tracer, config))
    },
    unpatch (Connection) {
      this.unwrap(Connection.prototype, '_dispatch')
    }
  },
  {
    name: 'hapi',
    versions: ['>=17'],
    file: 'lib/core.js',
    patch (Core, tracer, config) {
      this.wrap(Core.prototype, '_dispatch', createWrapDispatch(tracer, config))
    },
    unpatch (Core) {
      this.unwrap(Core.prototype, '_dispatch')
    }
  },
  {
    name: 'hapi',
    versions: ['2 - 7.1'],
    file: 'lib/server.js',
    patch (Server, tracer, config) {
      this.wrap(Server.prototype, '_dispatch', createWrapDispatch(tracer, config))
    },
    unpatch (Server) {
      this.unwrap(Server.prototype, '_dispatch')
    }
  }
]
