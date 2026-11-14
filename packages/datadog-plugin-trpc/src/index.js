'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const TrpcProcedurePlugin = require('./procedure')
const TrpcRequestPlugin = require('./request')

class TrpcPlugin extends CompositePlugin {
  static id = 'trpc'
  static plugins = {
    request: TrpcRequestPlugin,
    procedure: TrpcProcedurePlugin,
  }
}

module.exports = TrpcPlugin
