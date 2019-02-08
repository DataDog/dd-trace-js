'use strict'

const web = require('./util/web')

function createWrapGenerate (tracer, config) {
  return function wrapGenerate (generate) {
    return function generateWithTrace (server, req, res, options) {
      const request = generate.apply(this, arguments)

      web.beforeEnd(req, () => {
        web.enterRoute(req, request.route.path)
      })

      return request
    }
  }
}

function createWrapExecute (tracer, config) {
  config = web.normalizeConfig(config)

  return function wrapExecute (execute) {
    return function executeWithTrace () {
      const req = this.raw.req

      web.beforeEnd(req, () => {
        web.enterRoute(req, this.route.path)
      })

      return execute.apply(this, arguments)
    }
  }
}

function createWrapDispatch (tracer, config) {
  config = web.normalizeConfig(config)

  return function wrapDispatch (dispatch) {
    return function dispatchWithTrace (options) {
      const handler = dispatch.apply(this, arguments)

      return function (req, res) {
        return web.instrument(tracer, config, req, res, 'hapi.request', () => {
          return handler.apply(this, arguments)
        })
      }
    }
  }
}

module.exports = [
  {
    name: 'hapi',
    versions: ['>=17.1'],
    file: 'lib/request.js',
    patch (Request, tracer, config) {
      this.wrap(Request, 'generate', createWrapGenerate(tracer, config))
    },
    unpatch (Request) {
      this.unwrap(Request, 'generate')
    }
  },
  {
    name: 'hapi',
    versions: ['8.5 - 17.0'],
    file: 'lib/request.js',
    patch (Generator, tracer, config) {
      this.wrap(Generator.prototype, 'request', createWrapGenerate(tracer, config))
    },
    unpatch (Generator) {
      this.unwrap(Generator.prototype, 'request')
    }
  },
  {
    name: 'hapi',
    versions: ['2 - 8.4'],
    file: 'lib/request.js',
    patch (Request, tracer, config) {
      this.wrap(Request.prototype, '_execute', createWrapExecute(tracer, config))
    },
    unpatch (Request) {
      this.unwrap(Request.prototype, '_execute')
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
