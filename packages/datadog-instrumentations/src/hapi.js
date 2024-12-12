'use strict'

const tracingChannel = require('dc-polyfill').tracingChannel
const shimmer = require('../../datadog-shimmer')
const { addHook, channel } = require('./helpers/instrument')

const handleChannel = channel('apm:hapi:request:handle')
const routeChannel = channel('apm:hapi:request:route')
const errorChannel = channel('apm:hapi:request:error')
const hapiTracingChannel = tracingChannel('apm:hapi:extension')

function wrapServer (server) {
  return function (options) {
    const app = server.apply(this, arguments)

    if (!app) return app

    if (typeof app.ext === 'function') {
      app.ext = wrapExt(app.ext)
    }

    if (typeof app.start === 'function') {
      app.start = wrapStart(app.start)
    }

    return app
  }
}

function wrapStart (start) {
  return shimmer.wrapFunction(start, start => function () {
    if (this && typeof this.ext === 'function') {
      this.ext('onPreResponse', onPreResponse)
    }

    return start.apply(this, arguments)
  })
}

function wrapExt (ext) {
  return shimmer.wrapFunction(ext, ext => function (events, method, options) {
    if (events !== null && typeof events === 'object') {
      arguments[0] = wrapEvents(events)
    } else {
      arguments[1] = wrapExtension(method)
    }

    return ext.apply(this, arguments)
  })
}

function wrapDispatch (dispatch) {
  return function (options) {
    const handler = dispatch.apply(this, arguments)

    if (typeof handler !== 'function') return handler

    return function (req, res) {
      handleChannel.publish({ req, res })

      return handler.apply(this, arguments)
    }
  }
}

function wrapRebuild (rebuild) {
  return function (event) {
    const result = rebuild.apply(this, arguments)

    if (this && Array.isArray(this._cycle)) {
      this._cycle = this._cycle.map(wrapHandler)
    }

    return result
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

  return shimmer.wrapFunction(handler, handler => function (request, h) {
    const req = request && request.raw && request.raw.req

    if (!req) return handler.apply(this, arguments)

    return hapiTracingChannel.traceSync(() => {
      return handler.apply(this, arguments)
    })
  })
}

function onPreResponse (request, h) {
  if (!request || !request.raw) return reply(request, h)

  const req = request.raw.req

  if (request.response instanceof Error) {
    errorChannel.publish(request.response)
  }

  if (request.route) {
    routeChannel.publish({ req, route: request.route.path })
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

addHook({ name: '@hapi/hapi', versions: ['>=17.9'] }, hapi => {
  shimmer.massWrap(hapi, ['server', 'Server'], wrapServer)

  return hapi
})

addHook({ name: '@hapi/hapi', versions: ['>=17.9'], file: 'lib/core.js' }, Core => {
  shimmer.wrap(Core.prototype, '_dispatch', wrapDispatch)

  return Core
})

addHook({ name: '@hapi/hapi', versions: ['>=17.9'], file: 'lib/route.js' }, Route => {
  shimmer.wrap(Route.prototype, 'rebuild', wrapRebuild)

  return Route
})

addHook({ name: 'hapi', versions: ['>=17'] }, hapi => {
  shimmer.massWrap(hapi, ['server', 'Server'], wrapServer)

  return hapi
})

addHook({ name: 'hapi', versions: ['16'] }, hapi => {
  shimmer.wrap(hapi.Server.prototype, 'start', wrapStart)
  shimmer.wrap(hapi.Server.prototype, 'ext', wrapExt)

  return hapi
})

addHook({ name: 'hapi', versions: ['16'], file: 'lib/connection.js' }, Connection => {
  shimmer.wrap(Connection.prototype, '_dispatch', wrapDispatch)

  return Connection
})

addHook({ name: 'hapi', versions: ['>=17'], file: 'lib/core.js' }, Core => {
  shimmer.wrap(Core.prototype, '_dispatch', wrapDispatch)

  return Core
})

addHook({ name: 'hapi', versions: ['>=16'], file: 'lib/route.js' }, Route => {
  shimmer.wrap(Route.prototype, 'rebuild', wrapRebuild)

  return Route
})
