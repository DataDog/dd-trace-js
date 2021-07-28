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
          const _datadog = {}
          tracer.inject(span, 'text_map', _datadog)
          if (!request.params.ClientContext) {
            const context = { custom: { _datadog } }
            request.params.ClientContext = Buffer.from(JSON.stringify(context)).toString('base64')
          } else {
            const existingContextJson = Buffer.from(request.params.ClientContext, 'base64').toString('utf-8')
            const existingContext = JSON.parse(existingContextJson)

            if (existingContext.custom) {
              existingContext.custom._datadog = _datadog
            } else {
              existingContext.custom = { _datadog }
            }
            const newContextBase64 = Buffer.from(JSON.stringify(existingContext)).toString('base64')
            request.params.ClientContext = newContextBase64
          }
        } catch (err) {
          log.error(err)
        }
      }
    }
  }
}

module.exports = Lambda
