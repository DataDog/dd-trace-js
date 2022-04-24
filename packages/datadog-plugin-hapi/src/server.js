'use strict'

const web = require('../../dd-trace/src/plugins/util/web')

console.log('outside all the server'); // start before all

function createWrapDispatch (tracer, config) { // #1
  console.log('server inside createWrapDispatch');
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

function createWrapServer (tracer) { // #2
  console.log('server inside createWrapServer');
  return function wrapServer (server) {
    return function serverWithTrace (options) {
      const app = server.apply(this, arguments)

      if (!app) return app
      // first start the server.ext events;
      // const typOfApp = typeof app.start;
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

function createWrapStart () { // #4
  console.log('server inside createWrapStart');
  return function wrapStart (start) {
    return function startWithTrace () {
      if (this && typeof this.ext === 'function') {
        this.ext('onPreResponse', onPreResponse)
      }

      return start.apply(this, arguments)
    }
  }
}

function createWrapExt () { // #3
  console.log('server inside createWrapExt');
  return function wrapExt (ext) {
    return function extWithTrace (events, method, options) {
      if (typeof events === 'object') { // #6 #12
        arguments[0] = wrapEvents(events)
      } else {
        arguments[1] = wrapExtension(method)
      }

      return ext.apply(this, arguments)
    }
  }
}

function wrapExtension (method, type) { // #8 #10 #13
  console.log('server inside wrapExtension');
  return [].concat(method).map((m) => {
    if (type !== 'onPreStart') {
      return wrapHandler(m);
    } else {
      return wrapServerEvents(m)
    }
  })
}

function wrapEvents (events) { // #7
  console.log('server inside wrapEvents');
  return [].concat(events).map(event => {
    if (!event || !event.method) return event

    return Object.assign({}, event, {
      method: wrapExtension(event.method, event.type)
    })
  })
}
function wrapServerEvents (method) {
  console.log('server inside wrapServerEvents');
  if (!method) return method

  return function (server) { // https://github.com/hapijs/hapi/blob/master/lib/server.js#L269-L272
    if (!server) return method.apply(this, arguments) //OnPreStart Step 1
    // return web.reactivate(request.raw.req, () => handler.apply(this, arguments)) //OnRequest Step 1
    return web.reactivateServerScope(() => method.apply(this, arguments)  )
  }
}
function wrapHandler (handler) {
  console.log('server inside wrapHandler');
  if (typeof handler !== 'function') return handler

  return function (request, h) {
    if (!request || !request.raw) return handler.apply(this, arguments)

    return web.reactivate(request.raw.req, () => handler.apply(this, arguments))
  }
}

function onPreResponse (request, h) {
  console.log('server inside onPreResponse');
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
      console.log('server inside @hapi/hapi >=17.9 1');
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
      console.log('server inside @hapi/hapi >=17');
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
      console.log('server inside @hapi/hapi 2 - 7.1');
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
      console.log('server inside @hapi/hapi ^7.2');
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
      console.log('server inside @hapi/hapi >=17.9 2');
      this.wrap(Core.prototype, '_dispatch', createWrapDispatch(tracer, config)) // #1
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
      console.log('server inside @hapi/hapi 7.2 - 16');
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
      console.log('server inside @hapi/hapi >=17');
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
      console.log('server inside @hapi/hapi 2 - 7.1');
      this.wrap(Server.prototype, '_dispatch', createWrapDispatch(tracer, config))
    },
    unpatch (Server) {
      this.unwrap(Server.prototype, '_dispatch')
    }
  }
]
