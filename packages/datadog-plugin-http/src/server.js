'use strict'

const web = require('../../dd-trace/src/plugins/util/web')
const Scope = require('../../dd-trace/src/scope')

function createWrapEmit (tracer, config) {
  config = web.normalizeConfig(config)

  return function wrapEmit (emit) {
    return function emitWithTrace (eventName, req, res) {
      if (eventName === 'request') {
        return web.instrument(tracer, config, req, res, 'http.request', () => {
          return emit.apply(this, arguments)
        })
      }

      return emit.apply(this, arguments)
    }
  }
}

function plugin (name) {
  return {
    name,
    patch (http, tracer, config) {
      if (config.server === false) return

      this.wrap(http.Server.prototype, 'emit', createWrapEmit(tracer, config))
      if (http.ServerResponse) { // not present on https
        Scope._wrapEmitter(http.ServerResponse.prototype)
      }
    },
    unpatch (http) {
      this.unwrap(http.Server.prototype, 'emit')
    }
  }
}

module.exports = [
  plugin('http'),
  plugin('https')
]
