'use strict'

const BaseAwsSdkPlugin = require('../base')
const log = require('../../../dd-trace/src/log')

const PROVIDER = {
  AI21: 'AI21',
  AMAZON: 'AMAZON',
  ANTHROPIC: 'ANTHROPIC',
  COHERE: 'COHERE',
  META: 'META',
  STABILITY: 'STABILITY',
  MISTRAL: 'MISTRAL'
};

const enabledOperations = ['invokeModel']

class BedrockRuntime extends BaseAwsSdkPlugin {
  static get id () { return 'bedrock runtime' }

  isEnabled (request) {
    const operation = request.operation
    if (!enabledOperations.includes(operation)) {
      return false
    }

    return super.isEnabled(request)
  }

  generateTags (params, operation, response) {
    let tags = {}
    let modelName = ''
    let modelProvider = ''
    const modelMeta = params.modelId.split('.')
    if (modelMeta.length === 2) {
      [modelProvider, modelName] = modelMeta
      modelProvider = modelProvider.toUpperCase()
    } else {
      [, modelProvider, modelName] = modelMeta
      modelProvider = modelProvider.toUpperCase()
    }

    const shouldSetChoiceIds = modelProvider === PROVIDER.COHERE && !modelName.includes('embed')

    const requestParams = extractRequestParams(params, modelProvider)
    const textAndResponseReason = extractTextAndResponseReason(response, modelProvider, modelName, shouldSetChoiceIds)

    tags = buildTagsFromParams(requestParams, textAndResponseReason, modelProvider, modelName, operation)

    return tags
  }
}

class Generation {
  constructor(message, finish_reason, choice_id) {
    this.message = message || ''
    this.finish_reason = finish_reason || ''
    this.choice_id = choice_id
  }
}

class RequestParams {
  constructor(prompt, temperature, top_p, max_tokens, stop_sequences, input_type, truncate, stream, n) {
    this.prompt = prompt || ''
    this.temperature = temperature || ''
    this.top_p = top_p || ''
    this.max_tokens = max_tokens || ''
    this.stop_sequences = stop_sequences || []
    this.input_type = input_type || ''
    this.truncate = truncate || ''
    this.stream = stream || ''
    this.n = n || ''
  }
}

function extractRequestParams(params, provider) {
  const requestBody = JSON.parse(params.body)
  const modelId = params.modelId

  switch (provider) {
    case PROVIDER.AI21:
      let userPrompt = requestBody.prompt
      if (modelId.includes('jamba')) {
        for (const message of requestBody.messages) {
          if (message.role === 'user') {
            userPrompt = message.content // Return the content of the most recent user message
          }
        }
      }
      return new RequestParams(userPrompt, requestBody.temperature, requestBody.top_p, requestBody.max_tokens, requestBody.stop_sequences)
    case PROVIDER.AMAZON:
      if (modelId.includes('embed')) {
        return new RequestParams(requestBody.inputText)
      }
      const textGenerationConfig = requestBody.textGenerationConfig || {}
      return new RequestParams(requestBody.inputText, textGenerationConfig.temperature, textGenerationConfig.topP, textGenerationConfig.maxTokenCount, textGenerationConfig.stopSequences)
    case PROVIDER.ANTHROPIC:
      const prompt = requestBody.prompt || requestBody.messages
      return new RequestParams(prompt, requestBody.temperature, requestBody.top_p, requestBody.max_tokens_to_sample, requestBody.stop_sequences)
    case PROVIDER.COHERE:
      if (modelId.includes('embed')) {
        return new RequestParams(requestBody.texts, '', '', '', '', requestBody.input_type, requestBody.truncate)
      }
      return new RequestParams(requestBody.prompt, requestBody.temperature, requestBody.p, requestBody.max_tokens, requestBody.stop_sequences, '', '', requestBody.stream, requestBody.num_generations)
    case PROVIDER.META:
      return new RequestParams(requestBody.prompt, requestBody.temperature, requestBody.top_p, requestBody.max_gen_len)
    case PROVIDER.MISTRAL:
      return new RequestParams(requestBody.prompt, requestBody.temperature, requestBody.top_p, requestBody.max_tokens, requestBody.stop, '', '', '', '', requestBody.top_k)
    case PROVIDER.STABILITY:
      return new RequestParams()
    default:
      return new RequestParams()
  }
}

function extractTextAndResponseReason (response, provider, modelName, shouldSetChoiceIds) {
  const body = JSON.parse(Buffer.from(response.body).toString('utf8'))

  try {
    switch (provider) {
      case PROVIDER.AI21:
        if (modelName.includes('jamba')) {
          const generations = body.choices || []
          if (generations.length > 0) {
            const generation = generations[0]
            return new Generation(generation.message, generation.finish_reason, shouldSetChoiceIds ? generation.id : undefined)
          }
        }
        const completions = body.completions || []
        if (completions.length > 0) {
          const completion = completions[0]
          return new Generation(completion.data?.text, completion?.finishReason, shouldSetChoiceIds ? completion?.id : undefined)
        }
        return new Generation('', '', undefined)
      case PROVIDER.AMAZON:
        if (modelName.includes('embed')) {
          return new Generation(body.embedding, '', undefined)
        }
        const results = body.results || []
        if (results.length > 0) {
          const result = results[0]
          return new Generation(result.outputText, result.completionReason, undefined)
        }
        break
      case PROVIDER.ANTHROPIC:
        return new Generation(body.completion || body.content, body.stop_reason, undefined)
      case PROVIDER.COHERE:
        if (modelName.includes('embed')) {
          const embeddings = body.embeddings || [[]]
          if (embeddings.length > 0) {
            return new Generation(embeddings[0], '', undefined)
          }
        }
        const generations = body.generations || []
        if (generations.length > 0) {
          const generation = generations[0]
          return new Generation(generation.text, generation.finish_reason, shouldSetChoiceIds ? generation.id : undefined)
        }
        break
      case PROVIDER.META:
        return new Generation(body.generation, body.stop_reason, undefined)
      case PROVIDER.MISTRAL:
        const mistralGenerations = body.outputs || []
        if (mistralGenerations.length > 0) {
          const generation = mistralGenerations[0]
          return new Generation(generation.text, generation.stop_reason, undefined)
        }
        break
      case PROVIDER.STABILITY:
        return new Generation('', '', undefined)
      default:
        return new Generation('', '', undefined)
    }
  } catch (error) {
    log.warn('Unable to extract text/finish_reason from response body. Defaulting to empty text/finish_reason.')
    return new Generation('', '', undefined)
  }

  return new Generation('', '', undefined)
}

function buildTagsFromParams (requestParams, textAndResponseReason, modelProvider, modelName, operation) {
  const tags = {}

  // add request tags
  tags['resource.name'] = operation
  tags['aws.bedrock.request.model'] = modelName
  tags['aws.bedrock.request.model_provider'] = modelProvider
  tags['aws.bedrock.request.prompt'] = requestParams.prompt
  tags['aws.bedrock.request.temperature'] = requestParams.temperature
  tags['aws.bedrock.request.top_p'] = requestParams.top_p
  tags['aws.bedrock.request.max_tokens'] = requestParams.max_tokens
  tags['aws.bedrock.request.stop_sequences'] = requestParams.stop_sequences

  // add response tags
  if (modelName.includes('embed')) {
    tags['aws.bedrock.response.embedding_length'] = textAndResponseReason.message.length
  }
  if (textAndResponseReason.choice_id) {
    tags['aws.bedrock.response.choices.id'] = textAndResponseReason.choice_id
  }
  tags['aws.bedrock.response.choices.text'] = textAndResponseReason.message
  tags['aws.bedrock.response.choices.finish_reason'] = textAndResponseReason.finish_reason

  return tags
}

module.exports = BedrockRuntime
