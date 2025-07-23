'use strict'

const BaseAwsSdkPlugin = require('../../base')
const { parseModelId } = require('./utils')

const enabledOperations = new Set(['invokeModel'])

class BedrockRuntime extends BaseAwsSdkPlugin {
  static get id () { return 'bedrockruntime' }

  isEnabled (request) {
    const operation = request.operation
    if (!enabledOperations.has(operation)) {
      return false
    }

    return super.isEnabled(request)
  }

  generateTags (params, operation, response) {
    const { modelProvider, modelName } = parseModelId(params.modelId)

    return {
      'resource.name': operation,
      'aws.bedrock.request.model': modelName,
      'aws.bedrock.request.model_provider': modelProvider.toLowerCase()
    }
  }
}

module.exports = BedrockRuntime
