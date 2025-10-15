'use strict'

const HttpServerPlugin = require('./server')
const HttpClientPlugin = require('./client')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')

class HttpPlugin extends CompositePlugin {
  static id = 'http'
  static get plugins () {
    return {
      server: HttpServerPlugin,
      client: HttpClientPlugin
    }
  }
}

module.exports = HttpPlugin
