'use strict'

const InferredProxyPlugin = require('../../datadog-plugin-inferred-proxy/src')

class ApiGatewayPlugin extends InferredProxyPlugin {
  static id = 'aws-apigateway'
}

module.exports = ApiGatewayPlugin
