'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const GrpcServerPlugin = require('./server')
const GrpcClientPlugin = require('./client')

class GrpcPlugin extends CompositePlugin {
  static id = 'grpc'
  static get plugins () {
    return {
      server: GrpcServerPlugin,
      client: GrpcClientPlugin
    }
  }
}

module.exports = GrpcPlugin
