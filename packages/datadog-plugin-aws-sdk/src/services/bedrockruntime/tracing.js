'use strict'

const BaseAwsSdkPlugin = require('../../base')
const { parseModelId, extractRequestParams, extractTextAndResponseReason } = require('./utils')

const enabledOperations = ['invokeModel']

class BedrockRuntime extends BaseAwsSdkPlugin {
  static get id () { return 'bedrockruntime' }

  isEnabled (request) {
    const operation = request.operation
    if (!enabledOperations.includes(operation)) {
      return false
    }

    return super.isEnabled(request)
  }

  generateTags (params, operation, response) {
    const { modelProvider, modelName } = parseModelId(params.modelId)

    const requestParams = extractRequestParams(params, modelProvider)
    const textAndResponseReason = extractTextAndResponseReason(response, modelProvider, modelName)

    const tags = buildTagsFromParams(requestParams, textAndResponseReason, modelProvider, modelName, operation)

    return tags
  }
}

function buildTagsFromParams (requestParams, textAndResponseReason, modelProvider, modelName, operation) {
  const tags = {}

  // add request tags
  tags['resource.name'] = operation
  tags['aws.bedrock.request.model'] = modelName
  tags['aws.bedrock.request.model_provider'] = modelProvider.toLowerCase()
  tags['aws.bedrock.request.prompt'] = requestParams.prompt
  tags['aws.bedrock.request.temperature'] = requestParams.temperature
  tags['aws.bedrock.request.top_p'] = requestParams.topP
  tags['aws.bedrock.request.top_k'] = requestParams.topK
  tags['aws.bedrock.request.max_tokens'] = requestParams.maxTokens
  tags['aws.bedrock.request.stop_sequences'] = requestParams.stopSequences
  tags['aws.bedrock.request.input_type'] = requestParams.inputType
  tags['aws.bedrock.request.truncate'] = requestParams.truncate
  tags['aws.bedrock.request.stream'] = requestParams.stream
  tags['aws.bedrock.request.n'] = requestParams.n

  // add response tags
  if (modelName.includes('embed')) {
    tags['aws.bedrock.response.embedding_length'] = textAndResponseReason.message.length
  }
  if (textAndResponseReason.choiceId) {
    tags['aws.bedrock.response.choices.id'] = textAndResponseReason.choiceId
  }
  tags['aws.bedrock.response.choices.text'] = textAndResponseReason.message
  tags['aws.bedrock.response.choices.finish_reason'] = textAndResponseReason.finishReason

  return tags
}

module.exports = BedrockRuntime
