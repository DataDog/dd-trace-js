'use strict'

const web = require('../util/web')

function createWrapListen (tracer, config) {
  config = web.normalizeConfig(config)

  return function wrapListen (listen) {
    const listener = (req, res) => {
      web.instrument(tracer, config, req, res, 'http.request')
    }

    return function listenWithTrace () {
      this.removeListener('request', listener)
      this.prependListener('request', listener)

      return listen.apply(this, arguments)
    }
  }
}

function plugin (name) {
  return {
    name,
    patch (http, tracer, config) {
      this.wrap(http.Server.prototype, 'listen', createWrapListen(tracer, config))
    },
    unpatch (http) {
      this.unwrap(http.Server.prototype, 'listen')
    }
  }
}

module.exports = [
  plugin('http'),
  plugin('https')
]
