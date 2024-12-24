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
  constructor({ message = '', finish_reason = '', choice_id = '' } = {}) {
    // stringify message as it could be a single generated message as well as a list of embeddings
    this.message =  typeof prompt === 'string' ? prompt : JSON.stringify(prompt) || ''
    this.finish_reason = finish_reason || ''
    this.choice_id = choice_id || undefined
    this.message = typeof message === 'string' ? message : JSON.stringify(message) || ''
  }
}

class RequestParams {
  constructor({ prompt = '', temperature = undefined, top_p = undefined, max_tokens = undefined, stop_sequences = [], input_type = '', truncate = '', stream = '', n = undefined } = {}) {
    // TODO: set a truncation limit to prompt
    // stringify prompt as it could be a single prompt as well as a list of message objects
    this.prompt = typeof prompt === 'string' ? prompt : JSON.stringify(prompt) || ''
    this.temperature = temperature !== undefined ? temperature : undefined
    this.top_p = top_p !== undefined ? top_p : undefined
    this.max_tokens = max_tokens !== undefined ? max_tokens : undefined
    this.stop_sequences = stop_sequences || []
    this.input_type = input_type || ''
    this.truncate = truncate || ''
    this.stream = stream || ''
    this.n = n !== undefined ? n : undefined
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
      return new RequestParams({ prompt: userPrompt, temperature: requestBody.temperature, top_p: requestBody.top_p, max_tokens: requestBody.max_tokens, stop_sequences: requestBody.stop_sequences })
    case PROVIDER.AMAZON:
      if (modelId.includes('embed')) {
        return new RequestParams({ prompt: requestBody.inputText })
      }
      const textGenerationConfig = requestBody.textGenerationConfig || {}
      return new RequestParams({ prompt: requestBody.inputText, temperature: textGenerationConfig.temperature, top_p: textGenerationConfig.topP, max_tokens: textGenerationConfig.maxTokenCount, stop_sequences: textGenerationConfig.stopSequences })
    case PROVIDER.ANTHROPIC:
      const prompt = requestBody.prompt || requestBody.messages
      return new RequestParams({ prompt: prompt, temperature: requestBody.temperature, top_p: requestBody.top_p, max_tokens: requestBody.max_tokens_to_sample, stop_sequences: requestBody.stop_sequences })
    case PROVIDER.COHERE:
      if (modelId.includes('embed')) {
        return new RequestParams({ prompt: requestBody.texts, input_type: requestBody.input_type, truncate: requestBody.truncate })
      }
      return new RequestParams({ prompt: requestBody.prompt, temperature: requestBody.temperature, top_p: requestBody.p, max_tokens: requestBody.max_tokens, stop_sequences: requestBody.stop_sequences, stream: requestBody.stream, n: requestBody.num_generations })
    case PROVIDER.META:
      return new RequestParams({ prompt: requestBody.prompt, temperature: requestBody.temperature, top_p: requestBody.top_p, max_tokens: requestBody.max_gen_len })
    case PROVIDER.MISTRAL:
      return new RequestParams({ prompt: requestBody.prompt, temperature: requestBody.temperature, top_p: requestBody.top_p, max_tokens: requestBody.max_tokens, stop_sequences: requestBody.stop, top_k: requestBody.top_k })
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
            return new Generation({ message: generation.message, finish_reason: generation.finish_reason, choice_id: shouldSetChoiceIds ? generation.id : undefined })
          }
        }
        const completions = body.completions || []
        if (completions.length > 0) {
          const completion = completions[0]
          return new Generation({ message: completion.data?.text, finish_reason: completion?.finishReason, choice_id: shouldSetChoiceIds ? completion?.id : undefined })
        }
        return new Generation()
      case PROVIDER.AMAZON:
        if (modelName.includes('embed')) {
          return new Generation({ message: body.embedding })
        }
        const results = body.results || []
        if (results.length > 0) {
          const result = results[0]
          return new Generation({ message: result.outputText, finish_reason: result.completionReason })
        }
        break
      case PROVIDER.ANTHROPIC:
        return new Generation({ message: body.completion || body.content, finish_reason: body.stop_reason })
      case PROVIDER.COHERE:
        if (modelName.includes('embed')) {
          const embeddings = body.embeddings || [[]]
          if (embeddings.length > 0) {
            return new Generation({ message: embeddings[0] })
          }
        }
        const generations = body.generations || []
        if (generations.length > 0) {
          const generation = generations[0]
          return new Generation({ message: generation.text, finish_reason: generation.finish_reason, choice_id: shouldSetChoiceIds ? generation.id : undefined })
        }
        break
      case PROVIDER.META:
        return new Generation({ message: body.generation, finish_reason: body.stop_reason })
      case PROVIDER.MISTRAL:
        const mistralGenerations = body.outputs || []
        if (mistralGenerations.length > 0) {
          const generation = mistralGenerations[0]
          return new Generation({ message: generation.text, finish_reason: generation.stop_reason })
        }
        break
      case PROVIDER.STABILITY:
        return new Generation()
      default:
        return new Generation()
    }
  } catch (error) {
    log.warn('Unable to extract text/finish_reason from response body. Defaulting to empty text/finish_reason.')
    return new Generation()
  }

  return new Generation()
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
