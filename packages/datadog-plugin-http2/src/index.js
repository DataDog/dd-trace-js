'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const Http2ServerPlugin = require('./server')
const Http2ClientPlugin = require('./client')

class Http2Plugin extends Plugin {
  static get name () {
    return 'http2'
  }

  constructor (...args) {
    super(...args)

    this.server = new Http2ServerPlugin(...args)
    this.client = new Http2ClientPlugin(...args)
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

module.exports = Http2Plugin
