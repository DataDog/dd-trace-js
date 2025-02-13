'use strict'

const log = require('../../../../dd-trace/src/log')

const MODEL_TYPE_IDENTIFIERS = [
  'foundation-model/',
  'custom-model/',
  'provisioned-model/',
  'imported-module/',
  'prompt/',
  'endpoint/',
  'inference-profile/',
  'default-prompt-router/'
]

const PROVIDER = {
  AI21: 'AI21',
  AMAZON: 'AMAZON',
  ANTHROPIC: 'ANTHROPIC',
  COHERE: 'COHERE',
  META: 'META',
  STABILITY: 'STABILITY',
  MISTRAL: 'MISTRAL'
}

class Generation {
  constructor ({
    message = '',
    finishReason = '',
    choiceId = '',
    role,
    inputTokens,
    outputTokens
  } = {}) {
    // stringify message as it could be a single generated message as well as a list of embeddings
    this.message = typeof message === 'string' ? message : JSON.stringify(message) || ''
    this.finishReason = finishReason || ''
    this.choiceId = choiceId || undefined
    this.role = role
    this.usage = {
      inputTokens,
      outputTokens
    }
  }
}

class RequestParams {
  constructor ({
    prompt = '',
    temperature = undefined,
    topP = undefined,
    topK = undefined,
    maxTokens = undefined,
    stopSequences = [],
    inputType = '',
    truncate = '',
    stream = '',
    n = undefined
  } = {}) {
    // stringify prompt as it could be a single prompt as well as a list of message objects
    this.prompt = typeof prompt === 'string' ? prompt : JSON.stringify(prompt) || ''
    this.temperature = temperature !== undefined ? temperature : undefined
    this.topP = topP !== undefined ? topP : undefined
    this.topK = topK !== undefined ? topK : undefined
    this.maxTokens = maxTokens !== undefined ? maxTokens : undefined
    this.stopSequences = stopSequences || []
    this.inputType = inputType || ''
    this.truncate = truncate || ''
    this.stream = stream || ''
    this.n = n !== undefined ? n : undefined
  }
}

function parseModelId (modelId) {
  // Best effort to extract the model provider and model name from the bedrock model ID.
  // modelId can be a 1/2 period-separated string or a full AWS ARN, based on the following formats:
  // 1. Base model: "{model_provider}.{model_name}"
  // 2. Cross-region model: "{region}.{model_provider}.{model_name}"
  // 3. Other: Prefixed by AWS ARN "arn:aws{+region?}:bedrock:{region}:{account-id}:"
  //     a. Foundation model: ARN prefix + "foundation-model/{region?}.{model_provider}.{model_name}"
  //     b. Custom model: ARN prefix + "custom-model/{model_provider}.{model_name}"
  //     c. Provisioned model: ARN prefix + "provisioned-model/{model-id}"
  //     d. Imported model: ARN prefix + "imported-module/{model-id}"
  //     e. Prompt management: ARN prefix + "prompt/{prompt-id}"
  //     f. Sagemaker: ARN prefix + "endpoint/{model-id}"
  //     g. Inference profile: ARN prefix + "{application-?}inference-profile/{model-id}"
  //     h. Default prompt router: ARN prefix + "default-prompt-router/{prompt-id}"
  // If model provider cannot be inferred from the modelId formatting, then default to "custom"
  modelId = modelId.toLowerCase()
  if (!modelId.startsWith('arn:aws')) {
    const modelMeta = modelId.split('.')
    if (modelMeta.length < 2) {
      return { modelProvider: 'custom', modelName: modelMeta[0] }
    }
    return { modelProvider: modelMeta[modelMeta.length - 2], modelName: modelMeta[modelMeta.length - 1] }
  }

  for (const identifier of MODEL_TYPE_IDENTIFIERS) {
    if (!modelId.includes(identifier)) {
      continue
    }
    modelId = modelId.split(identifier).pop()
    if (['foundation-model/', 'custom-model/'].includes(identifier)) {
      const modelMeta = modelId.split('.')
      if (modelMeta.length < 2) {
        return { modelProvider: 'custom', modelName: modelId }
      }
      return { modelProvider: modelMeta[modelMeta.length - 2], modelName: modelMeta[modelMeta.length - 1] }
    }
    return { modelProvider: 'custom', modelName: modelId }
  }

  return { modelProvider: 'custom', modelName: 'custom' }
}

function extractRequestParams (params, provider) {
  const requestBody = JSON.parse(params.body)
  const modelId = params.modelId

  switch (provider.toUpperCase()) {
    case PROVIDER.AI21: {
      let userPrompt = requestBody.prompt
      if (modelId.includes('jamba')) {
        for (const message of requestBody.messages) {
          if (message.role === 'user') {
            userPrompt = message.content // Return the content of the most recent user message
          }
        }
      }
      return new RequestParams({
        prompt: userPrompt,
        temperature: requestBody.temperature,
        topP: requestBody.top_p,
        maxTokens: requestBody.max_tokens,
        stopSequences: requestBody.stop_sequences
      })
    }
    case PROVIDER.AMAZON: {
      if (modelId.includes('embed')) {
        return new RequestParams({ prompt: requestBody.inputText })
      }
      const textGenerationConfig = requestBody.textGenerationConfig || {}
      return new RequestParams({
        prompt: requestBody.inputText,
        temperature: textGenerationConfig.temperature,
        topP: textGenerationConfig.topP,
        maxTokens: textGenerationConfig.maxTokenCount,
        stopSequences: textGenerationConfig.stopSequences
      })
    }
    case PROVIDER.ANTHROPIC: {
      const prompt = requestBody.prompt || requestBody.messages
      return new RequestParams({
        prompt,
        temperature: requestBody.temperature,
        topP: requestBody.top_p,
        maxTokens: requestBody.max_tokens_to_sample,
        stopSequences: requestBody.stop_sequences
      })
    }
    case PROVIDER.COHERE: {
      if (modelId.includes('embed')) {
        return new RequestParams({
          prompt: requestBody.texts,
          inputType: requestBody.input_type,
          truncate: requestBody.truncate
        })
      }
      return new RequestParams({
        prompt: requestBody.prompt,
        temperature: requestBody.temperature,
        topP: requestBody.p,
        maxTokens: requestBody.max_tokens,
        stopSequences: requestBody.stop_sequences,
        stream: requestBody.stream,
        n: requestBody.num_generations
      })
    }
    case PROVIDER.META: {
      return new RequestParams({
        prompt: requestBody.prompt,
        temperature: requestBody.temperature,
        topP: requestBody.top_p,
        maxTokens: requestBody.max_gen_len
      })
    }
    case PROVIDER.MISTRAL: {
      return new RequestParams({
        prompt: requestBody.prompt,
        temperature: requestBody.temperature,
        topP: requestBody.top_p,
        maxTokens: requestBody.max_tokens,
        stopSequences: requestBody.stop,
        topK: requestBody.top_k
      })
    }
    case PROVIDER.STABILITY: {
      return new RequestParams()
    }
    default: {
      return new RequestParams()
    }
  }
}

function extractTextAndResponseReason (response, provider, modelName) {
  const body = JSON.parse(Buffer.from(response.body).toString('utf8'))
  const shouldSetChoiceIds = provider.toUpperCase() === PROVIDER.COHERE && !modelName.includes('embed')
  try {
    switch (provider.toUpperCase()) {
      case PROVIDER.AI21: {
        if (modelName.includes('jamba')) {
          const generations = body.choices || []
          if (generations.length > 0) {
            const generation = generations[0]
            return new Generation({
              message: generation.message.content,
              finishReason: generation.finish_reason,
              choiceId: shouldSetChoiceIds ? generation.id : undefined,
              role: generation.message.role,
              inputTokens: body.usage?.prompt_tokens,
              outputTokens: body.usage?.completion_tokens
            })
          }
        }
        const completions = body.completions || []
        if (completions.length > 0) {
          const completion = completions[0]
          return new Generation({
            message: completion.data?.text,
            finishReason: completion?.finishReason,
            choiceId: shouldSetChoiceIds ? completion?.id : undefined,
            inputTokens: body.usage?.prompt_tokens,
            outputTokens: body.usage?.completion_tokens
          })
        }
        return new Generation()
      }
      case PROVIDER.AMAZON: {
        if (modelName.includes('embed')) {
          return new Generation({ message: body.embedding })
        }
        const results = body.results || []
        if (results.length > 0) {
          const result = results[0]
          return new Generation({
            message: result.outputText,
            finishReason: result.completionReason,
            inputTokens: body.inputTextTokenCount,
            outputTokens: result.tokenCount
          })
        }
        break
      }
      case PROVIDER.ANTHROPIC: {
        return new Generation({ message: body.completion || body.content, finishReason: body.stop_reason })
      }
      case PROVIDER.COHERE: {
        if (modelName.includes('embed')) {
          const embeddings = body.embeddings || [[]]
          if (embeddings.length > 0) {
            return new Generation({ message: embeddings[0] })
          }
        }
        const generations = body.generations || []
        if (generations.length > 0) {
          const generation = generations[0]
          return new Generation({
            message: generation.text,
            finishReason: generation.finish_reason,
            choiceId: shouldSetChoiceIds ? generation.id : undefined
          })
        }
        break
      }
      case PROVIDER.META: {
        return new Generation({
          message: body.generation,
          finishReason: body.stop_reason,
          inputTokens: body.prompt_token_count,
          outputTokens: body.generation_token_count
        })
      }
      case PROVIDER.MISTRAL: {
        const mistralGenerations = body.outputs || []
        if (mistralGenerations.length > 0) {
          const generation = mistralGenerations[0]
          return new Generation({ message: generation.text, finishReason: generation.stop_reason })
        }
        break
      }
      case PROVIDER.STABILITY: {
        return new Generation()
      }
      default: {
        return new Generation()
      }
    }
  } catch (error) {
    log.warn('Unable to extract text/finishReason from response body. Defaulting to empty text/finishReason.')
    return new Generation()
  }

  return new Generation()
}

module.exports = {
  Generation,
  RequestParams,
  parseModelId,
  extractRequestParams,
  extractTextAndResponseReason,
  PROVIDER
}
