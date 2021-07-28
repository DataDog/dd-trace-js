'use strict'

const log = require('../../../dd-trace/src/log')

class Lambda {
  generateTags (params, operation, response) {
    const tags = {}

    if (!params || !params.FunctionName) return tags

    return Object.assign(tags, {
      'resource.name': `${operation} ${params.FunctionName}`,
      'aws.lambda': params.FunctionName
    })
  }

  requestInject (span, request, tracer) {
    const operation = request.operation
    if (operation === 'invoke') {
      if (!request.params) {
        request.params = {}
      }

      const isSyncInvocation = !request.params.InvocationType ||
        request.params.InvocationType === 'RequestResponse'

      if (isSyncInvocation) {
        try {
          let clientContext = {}
          if (request.params.ClientContext) {
            const clientContextJson = Buffer.from(request.params.ClientContext, 'base64').toString('utf-8')
            clientContext = JSON.parse(clientContextJson)
          }
          if (!clientContext.custom) {
            clientContext.custom = {}
          }
          clientContext.custom._datadog = {}
          tracer.inject(span, 'text_map', clientContext.custom._datadog)
          const newContextBase64 = Buffer.from(JSON.stringify(clientContext)).toString('base64')
          request.params.ClientContext = newContextBase64
        } catch (err) {
          log.error(err)
        }
      }
    }
  }
}

module.exports = Lambda
