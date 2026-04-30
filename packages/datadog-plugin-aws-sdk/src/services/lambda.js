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
      'aws.lambda': params.FunctionName,
    }
  }

  requestInject (span, request) {
    const operation = request.operation
    if (operation !== 'invoke') return

    if (!request.params) {
      request.params = {}
    }

    const isSyncInvocation = !request.params.InvocationType ||
      request.params.InvocationType === 'RequestResponse'
    if (!isSyncInvocation) return

    try {
      const injected = {}
      this.tracer.inject(span, 'text_map', injected)

      let newContextJson
      if (request.params.ClientContext) {
        const clientContextJson = Buffer.from(request.params.ClientContext, 'base64').toString('utf8')
        // When no `custom` field is present we can splice via the shared
        // helper. Otherwise parse and merge so existing customer keys
        // under `custom` survive the round-trip.
        if (clientContextJson.includes('"custom"')) {
          const clientContext = JSON.parse(clientContextJson)
          if (!clientContext.custom) clientContext.custom = {}
          Object.assign(clientContext.custom, injected)
          newContextJson = JSON.stringify(clientContext)
        } else {
          newContextJson = BaseAwsSdkPlugin.injectFieldIntoJsonObject(clientContextJson, 'custom', injected)
        }
      } else {
        newContextJson = `{"custom":${JSON.stringify(injected)}}`
      }
      request.params.ClientContext = Buffer.from(newContextJson).toString('base64')
    } catch (error) {
      log.error('Lambda error injecting request', error)
    }
  }

  operationFromRequest (request) {
    if (request.operation === 'invoke') {
      return this.operationName({
        type: 'web',
        kind: 'client',
      })
    }

    return this.operationName({
      id: 'aws',
      type: 'web',
      kind: 'client',
      awsService: 'lambda',
    })
  }
}

module.exports = Lambda
