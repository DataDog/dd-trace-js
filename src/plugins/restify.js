'use strict'

const web = require('./util/web')

function createWrapOnRequest (tracer, config) {
  config = web.normalizeConfig(config)

  return function wrapOnRequest (onRequest) {
    return function onRequestWithTrace (req, res) {
      web.instrument(tracer, config, req, res, 'restify.request')
      web.beforeEnd(req, () => {
        const route = req.getRoute()

        if (route) {
          web.enterRoute(req, route.path)
        }
      })

      return onRequest.apply(this, arguments)
    }
  }
}

function createWrapAdd (tracer, config) {
  return function wrapAdd (add) {
    return function addWithTrace (handler) {
      return add.call(this, function (req, res, next) {
        web.reactivate(req)
        handler.apply(this, arguments)
      })
    }
  }
}

module.exports = [
  {
    name: 'restify',
    versions: ['7.x'],
    file: 'lib/server.js',
    patch (Server, tracer, config) {
      this.wrap(Server.prototype, '_onRequest', createWrapOnRequest(tracer, config))
    },
    unpatch (Server) {
      this.unwrap(Server.prototype, '_onRequest')
    }
  },
  {
    name: 'restify',
    versions: ['7.x'],
    file: 'lib/chain.js',
    patch (Chain, tracer, config) {
      this.wrap(Chain.prototype, 'add', createWrapAdd(tracer, config))
    },
    unpatch (Chain) {
      this.unwrap(Chain.prototype, 'add')
    }
  }
]
