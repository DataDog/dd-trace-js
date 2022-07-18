'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const GrpcServerPlugin = require('./server')
const GrpcClientPlugin = require('./client')

class GrpcPlugin extends Plugin {
  static get name () {
    return 'grpc'
  }

  constructor (...args) {
    super(...args)
    this.server = new GrpcServerPlugin(...args)
    this.client = new GrpcClientPlugin(...args)
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

module.exports = GrpcPlugin
