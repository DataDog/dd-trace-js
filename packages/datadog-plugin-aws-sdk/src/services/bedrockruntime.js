'use strict'

const BaseAwsSdkPlugin = require('../base')
const log = require('../../../dd-trace/src/log')

const AI21 = 'AI21'
const AMAZON = 'AMAZON'
const ANTHROPIC = 'ANTHROPIC'
const COHERE = 'COHERE'
const META = 'META'
const STABILITY = 'STABILITY'
const MISTRAL = 'MISTRAL'

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

    const shouldSetChoiceIds = modelProvider === COHERE && !modelName.includes('embed')

    const requestParams = extractRequestParams(params, modelProvider)
    const textAndResponseReason = extractTextAndResponseReason(response, modelProvider, modelName, shouldSetChoiceIds)

    tags = buildTagsFromParams(requestParams, textAndResponseReason, modelProvider, modelName, operation)

    return tags
  }
}

function extractRequestParams (params, provider) {
  const requestBody = JSON.parse(params.body)
  const modelId = params.modelId

  if (provider === AI21) {
    const temperature = requestBody.temperature || ''
    const topP = requestBody.top_p || ''
    const maxTokens = requestBody.max_tokens || ''
    const stopSequences = requestBody.stop_sequences || []
    let prompt = requestBody.prompt

    if (modelId.includes('jamba')) {
      for (const message of requestBody.messages) {
        if (message.role === 'user') {
          prompt = message.content // Return the content of the most recent user message
        }
      }
    }
    return {
      prompt,
      temperature,
      top_p: topP,
      max_tokens: maxTokens,
      stop_sequences: stopSequences
    }
  } else if (provider === AMAZON && modelId.includes('embed')) {
    return { prompt: requestBody.inputText }
  } else if (provider === AMAZON) {
    const textGenerationConfig = requestBody.textGenerationConfig || {}
    return {
      prompt: requestBody.inputText,
      temperature: textGenerationConfig.temperature || '',
      top_p: textGenerationConfig.topP || '',
      max_tokens: textGenerationConfig.maxTokenCount || '',
      stop_sequences: textGenerationConfig.stopSequences || []
    }
  } else if (provider === ANTHROPIC) {
    const prompt = requestBody.prompt || ''
    const messages = requestBody.messages || ''
    return {
      prompt: prompt || messages,
      temperature: requestBody.temperature || '',
      top_p: requestBody.top_p || '',
      top_k: requestBody.top_k || '',
      max_tokens: requestBody.max_tokens_to_sample || '',
      stop_sequences: requestBody.stop_sequences || []
    }
  } else if (provider === COHERE && modelId.includes('embed')) {
    return {
      prompt: requestBody.texts,
      input_type: requestBody.input_type || '',
      truncate: requestBody.truncate || ''
    }
  } else if (provider === COHERE) {
    return {
      prompt: requestBody.prompt,
      temperature: requestBody.temperature || '',
      top_p: requestBody.p || '',
      top_k: requestBody.k || '',
      max_tokens: requestBody.max_tokens || '',
      stop_sequences: requestBody.stop_sequences || [],
      stream: requestBody.stream || '',
      n: requestBody.num_generations || ''
    }
  } else if (provider === META) {
    return {
      prompt: requestBody.prompt,
      temperature: requestBody.temperature || '',
      top_p: requestBody.top_p || '',
      max_tokens: requestBody.max_gen_len || ''
    }
  } else if (provider === MISTRAL) {
    return {
      prompt: requestBody.prompt,
      max_tokens: requestBody.max_tokens || '',
      stop_sequences: requestBody.stop || [],
      temperature: requestBody.temperature || '',
      top_p: requestBody.top_p || '',
      top_k: requestBody.top_k || ''
    }
  } else if (provider === STABILITY) {
    return {}
  }
  return {}
}

function extractTextAndResponseReason (response, provider, modelName, shouldSetChoiceIds) {
  const body = JSON.parse(Buffer.from(response.body).toString('utf8'))

  try {
    if (provider === AI21) {
      if (modelName.includes('jamba')) {
        const generations = body.choices || []
        if (generations.length > 0) {
          const generation = generations[0]
          return {
            text: generation.message || '',
            finish_reason: generation.finish_reason || '',
            choice_id: shouldSetChoiceIds ? generation.id : undefined
          }
        }
      }
      const completions = body.completions || []
      if (completions.length > 0) {
        const completion = completions[0]
        return {
          text: completion.data?.text || '',
          finish_reason: completion.finishReason || '',
          choice_id: shouldSetChoiceIds ? completion.id : undefined
        }
      }
    } else if (provider === AMAZON && modelName.includes('embed')) {
      return {
        text: body.embedding || '',
        finish_reason: '',
        choice_id: undefined
      }
    } else if (provider === AMAZON) {
      const results = body.results || []
      if (results.length > 0) {
        const result = results[0]
        return {
          text: result.outputText || '',
          finish_reason: result.completionReason || '',
          choice_id: undefined
        }
      }
    } else if (provider === ANTHROPIC) {
      return {
        text: body.completion || body.content || '',
        finish_reason: body.stop_reason || '',
        choice_id: undefined
      }
    } else if (provider === COHERE && modelName.includes('embed')) {
      const embeddings = body.embeddings || [[]]
      if (embeddings.length > 0) {
        return {
          text: embeddings[0],
          finish_reason: '',
          choice_id: undefined
        }
      }
    } else if (provider === COHERE) {
      const generations = body.generations || []
      if (generations.length > 0) {
        const generation = generations[0]
        return {
          text: generation.text,
          finish_reason: generation.finish_reason,
          choice_id: shouldSetChoiceIds ? generation.id : undefined
        }
      }
    } else if (provider === META) {
      return {
        text: body.generation || '',
        finish_reason: body.stop_reason || '',
        choice_id: undefined
      }
    } else if (provider === MISTRAL) {
      const generations = body.outputs || []
      if (generations.length > 0) {
        const generation = generations[0]
        return {
          text: generation.text || '',
          finish_reason: generation.stop_reason || '',
          choice_id: undefined
        }
      }
    } else if (provider === STABILITY) {
      // No text/finish_reason to extract return empty response if needed.
      return {
        text: '',
        finish_reason: '',
        choice_id: undefined
      }
    }
  } catch (error) {
    log.warn('Unable to extract text/finish_reason from response body. Defaulting to empty text/finish_reason.')
    return {
      text: '',
      finish_reason: '',
      choice_id: undefined
    }
  }

  // Default return in case nothing matches
  return {
    text: '',
    finish_reason: '',
    choice_id: undefined
  }
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
    tags['aws.bedrock.response.embedding_length'] = textAndResponseReason.text.length
  }
  if (textAndResponseReason.choice_id) {
    tags['aws.bedrock.response.choices.id'] = textAndResponseReason.choice_id
  }
  tags['aws.bedrock.response.choices.text'] = textAndResponseReason.text
  tags['aws.bedrock.response.choices.finish_reason'] = textAndResponseReason.finish_reason

  return tags
}

module.exports = BedrockRuntime
