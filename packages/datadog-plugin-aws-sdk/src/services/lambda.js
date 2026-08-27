'use strict'

const log = require('../../../dd-trace/src/log')
const {
  awsServiceSource,
  awsServiceV0,
  awsServiceV1,
  optionServiceSource,
} = require('../../../dd-trace/src/service-naming/helpers')
const BaseAwsSdkPlugin = require('../base')

/**
 * @param {import('../../../dd-trace/src/plugins/tracing').NamingOptions} options
 */
function lambdaOperationName ({ operation }) {
  return operation === 'invoke' ? 'aws.lambda.invoke' : 'aws.lambda.request'
}

/** @type {import('../../../dd-trace/src/plugins/tracing').NamingSchema} */
const namingSchema = {
  v0: {
    operationName: () => 'aws.request',
    serviceName: awsServiceV0,
    serviceSource: awsServiceSource,
  },
  v1: {
    operationName: lambdaOperationName,
    serviceName: awsServiceV1,
    serviceSource: optionServiceSource,
  },
}

class Lambda extends BaseAwsSdkPlugin {
  static id = 'lambda'

  /** @override */
  getNamingSchema () {
    return namingSchema
  }

  generateTags (params, operation, response) {
    if (!params?.FunctionName) return

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

    const injected = {}
    this.tracer.inject(span, 'text_map', injected)

    let newContextJson
    if (request.params.ClientContext) {
      const clientContextJson = Buffer.from(request.params.ClientContext, 'base64').toString('utf8')

      // The two throwing surfaces here are the inline `JSON.parse` and the
      // slow path inside `injectFieldIntoJsonObject`. Tighten the catch
      // around the JSON ops so the rest of the inject stays optimisable.
      try {
        if (clientContextJson.includes('"custom"')) {
          // Existing customer keys under `custom` survive the round-trip.
          const clientContext = JSON.parse(clientContextJson)
          if (!clientContext.custom) clientContext.custom = {}
          Object.assign(clientContext.custom, injected)
          newContextJson = JSON.stringify(clientContext)
        } else {
          newContextJson = BaseAwsSdkPlugin.injectFieldIntoJsonObject(clientContextJson, 'custom', injected)
        }
      } catch (error) {
        log.error('Lambda error injecting request', error)
        return
      }
    } else {
      newContextJson = `{"custom":${JSON.stringify(injected)}}`
    }
    request.params.ClientContext = Buffer.from(newContextJson).toString('base64')
  }

  operationFromRequest (request) {
    return this.operationName({
      awsService: 'lambda',
      operation: request.operation,
    })
  }
}

module.exports = Lambda
