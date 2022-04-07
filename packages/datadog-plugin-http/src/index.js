'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const HttpServerPlugin = require('./server')
const HttpClientPlugin = require('./client')

class HttpPlugin extends Plugin {
  static get name () {
    return 'http'
  }
  constructor (...args) {
    super(...args)
    this.server = new HttpServerPlugin(...args)
    this.client = new HttpClientPlugin(...args)
  }
  configure (config) {
    const clientConfig = config.client === false ? false : {
      ...config,
      ...config.client
    }

    const serverConfig = config.server === false ? false : {
      ...config,
      ...config.server
    }

    this.server.configure(serverConfig)
    this.client.configure(clientConfig)
  }
}

module.exports = HttpPlugin
