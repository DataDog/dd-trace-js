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

    const tags = buildTagsFromParams(modelProvider, modelName, operation)

    return tags
  }
}

function buildTagsFromParams (modelProvider, modelName, operation) {
  const tags = {}

  // add request tags
  tags['resource.name'] = operation
  tags['aws.bedrock.request.model'] = modelName
  tags['aws.bedrock.request.model_provider'] = modelProvider.toLowerCase()

  return tags
}

module.exports = BedrockRuntime
