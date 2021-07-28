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
          let clientContext = {}
          // eslint-disable-next-line no-console
          console.log('AGOCS! on lambda.js line 33, request.params is ' + JSON.stringify(request.params))
          if (request.params.ClientContext) {
            const clientContextJson = Buffer.from(request.params.clientContext, 'base64').toString('utf-8')
            clientContext = JSON.parse(clientContextJson)
          }
          // eslint-disable-next-line no-console
          console.log('AGOCS! on lambda.js line 39, clientContext is ' + JSON.stringify(clientContext))
          if (clientContext.custom) {
            clientContext.custom._datadog = _datadog
          } else {
            clientContext.custom = { _datadog }
          }
          // eslint-disable-next-line no-console
          console.log('AGOCS! on lambda.js line 46, the mutated clientContext is ' + JSON.stringify(clientContext))
          const newContextBase64 = Buffer.from(JSON.stringify(clientContext)).toString('base64')
          request.params.ClientContext = newContextBase64
        } catch (err) {
          // eslint-disable-next-line no-console
          console.log('AGOCS! We\'ve hit an error!' + err)
          log.error(err)
        }
      }
    }
  }
}

module.exports = Lambda
