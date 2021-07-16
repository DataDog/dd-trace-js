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
          const traceContext = {}
          tracer.inject(span, 'text_map', traceContext)

          let ClientContextObject = {}
          if (request.params.ClientContext) {
            ClientContextObject = Buffer.from(request.params.ClientContext, 'base64').toString('utf-8')
          }
          if (!ClientContextObject.custom) {
            ClientContextObject.custom = {}
          }

          // Check for legacy compatability here.
          ClientContextObject.custom = { '_datadog': traceContext }

          const updatedContextBase64 = Buffer.from(JSON.stringify(ClientContextObject)).toString('base64')
          request.params.ClientContext = updatedContextBase64
        } catch (err) {
          log.error(err)
        }
      }
    }
  }
}

module.exports = Lambda
