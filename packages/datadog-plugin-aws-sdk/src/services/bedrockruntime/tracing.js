'use strict'

const BaseAwsSdkPlugin = require('../../base')
const { parseModelId } = require('./utils')

const enabledOperations = new Set(['invokeModel', 'invokeModelWithResponseStream'])

class BedrockRuntime extends BaseAwsSdkPlugin {
  static id = 'bedrockruntime'

  isEnabled (request) {
    const operation = request.operation
    if (!enabledOperations.has(operation)) {
      return false
    }

    return super.isEnabled(request)
  }

  generateTags (params, operation) {
    const { modelProvider, modelName } = parseModelId(params.modelId)

    return {
      'resource.name': operation,
      'aws.bedrock.request.model': modelName,
      'aws.bedrock.request.model_provider': modelProvider.toLowerCase()
    }
  }
}

module.exports = BedrockRuntime
