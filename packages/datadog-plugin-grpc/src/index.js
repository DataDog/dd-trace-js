'use strict'

const GrpcServerPlugin = require('./server')
const GrpcClientPlugin = require('./client')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')

class GrpcPlugin extends CompositePlugin {
  static get name () { return 'grpc' }
  static get plugins () {
    return {
      server: GrpcServerPlugin,
      client: GrpcClientPlugin
    }
  }
}

module.exports = GrpcPlugin
