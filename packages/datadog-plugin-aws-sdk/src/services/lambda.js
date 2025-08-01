'use strict'

const log = require('../../../dd-trace/src/log')
const BaseAwsSdkPlugin = require('../base')

class Lambda extends BaseAwsSdkPlugin {
  static id = 'lambda'

  generateTags (params, operation, response) {
    if (!params?.FunctionName) return {}

    return {
      'resource.name': `${operation} ${params.FunctionName}`,
      functionname: params.FunctionName,
      'aws.lambda': params.FunctionName
    }
  }

  requestInject (span, request) {
    const operation = request.operation
    if (operation === 'invoke') {
      if (!request.params) {
        request.params = {}
      }

      const isSyncInvocation = !request.params.InvocationType ||
        request.params.InvocationType === 'RequestResponse'

      if (isSyncInvocation) {
        try {
          // Check to see if there's already a config on the request
          let clientContext = {}
          if (request.params.ClientContext) {
            const clientContextJson = Buffer.from(request.params.ClientContext, 'base64').toString('utf8')
            clientContext = JSON.parse(clientContextJson)
          }
          if (!clientContext.custom) {
            clientContext.custom = {}
          }
          this.tracer.inject(span, 'text_map', clientContext.custom)
          const newContextBase64 = Buffer.from(JSON.stringify(clientContext)).toString('base64')
          request.params.ClientContext = newContextBase64
        } catch (err) {
          log.error('Lambda error injecting request', err)
        }
      }
    }
  }

  operationFromRequest (request) {
    if (request.operation === 'invoke') {
      return this.operationName({
        type: 'web',
        kind: 'client'
      })
    }

    return this.operationName({
      id: 'aws',
      type: 'web',
      kind: 'client',
      awsService: 'lambda'
    })
  }
}

module.exports = Lambda
