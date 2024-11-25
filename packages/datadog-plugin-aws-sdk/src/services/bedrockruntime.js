'use strict'

const BaseAwsSdkPlugin = require('../base')

const _AI21 = 'ai21'
const _AMAZON = 'amazon'
const _ANTHROPIC = 'anthropic'
const _COHERE = 'cohere'
const _META = 'meta'
const _STABILITY = 'stability'

class BedrockRuntime extends BaseAwsSdkPlugin {
  static get id () { return 'bedrock runtime' }

  generateTags (params, operation, response) {
    const tags = {}
    let modelName = ''
    let modelProvider = ''
    const modelMeta = params.modelId.split('.')
    if (modelMeta.length === 2) {
      [modelProvider, modelName] = modelMeta
    } else {
      [, modelProvider, modelName] = modelMeta
    }
    const requestParams = extractRequestParams(params, modelProvider)
    const responseParams = extractResponseParams(response, modelProvider)

    Object.assign(tags, {
      'resource.name': `${operation}`,
      'aws.bedrock.request.model': modelName,
      'aws.bedrock.request.model_provider': modelProvider,
      'aws.bedrock.request.prompt': requestParams.prompt,
      'aws.bedrock.request.temperature': requestParams.temperature,
      'aws.bedrock.request.top_p': requestParams.top_p,
      'aws.bedrock.request.max_tokens': requestParams.max_tokens,
      'aws.bedrock.request.stop_sequences': requestParams.stop_sequences,
      // response tags only for amazon model
      'openai.response.usage.prompt_tokens': responseParams.input_token_count,
      'openai.response.usage.generated_tokens': responseParams.output_token_count
    })

    return tags
  }
}

function extractRequestParams (params, provider) {
  const requestBody = JSON.parse(params.body)
  const modelId = params.modelId

  if (provider === _AI21) {
    return {
      prompt: requestBody.prompt,
      temperature: requestBody.temperature || '',
      top_p: requestBody.topP || '',
      max_tokens: requestBody.maxTokens || '',
      stop_sequences: requestBody.stopSequences || []
    }
  } else if (provider === _AMAZON && modelId.includes('embed')) {
    return { prompt: requestBody.inputText }
  } else if (provider === _AMAZON) {
    const textGenerationConfig = requestBody.textGenerationConfig || {}
    return {
      prompt: requestBody.inputText,
      temperature: textGenerationConfig.temperature || '',
      top_p: textGenerationConfig.topP || '',
      max_tokens: textGenerationConfig.maxTokenCount || '',
      stop_sequences: textGenerationConfig.stopSequences || []
    }
  } else if (provider === _ANTHROPIC) {
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
  } else if (provider === _COHERE && modelId.includes('embed')) {
    return {
      prompt: requestBody.texts,
      input_type: requestBody.input_type || '',
      truncate: requestBody.truncate || ''
    }
  } else if (provider === _COHERE) {
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
  } else if (provider === _META) {
    return {
      prompt: requestBody.prompt,
      temperature: requestBody.temperature || '',
      top_p: requestBody.top_p || '',
      max_tokens: requestBody.max_gen_len || ''
    }
  } else if (provider === _STABILITY) {
    // TODO: request/response formats are different for image-based models. Defer for now
    return {}
  }
  return {}
}

function extractResponseParams (response, provider) {
  const responseBody = JSON.parse(Buffer.from(response.body).toString('utf8'))
  if (provider === _AI21) {
    return {}
  } else if (provider === _AMAZON) {
    // loop over responseBody.results and extract the token count
    const inputTokenCount = responseBody.inputTextTokenCount
    const outputTokenCount = responseBody.results.reduce((acc, result) => acc + result.tokenCount, 0)
    return {
      input_token_count: inputTokenCount,
      output_token_count: outputTokenCount
    }
  } else if (provider === _ANTHROPIC) {
    return {}
  } else if (provider === _COHERE) {
    return {}
  } else if (provider === _META) {
    return {}
  } else if (provider === _STABILITY) {
    return {}
  }
  return {}
}

module.exports = BedrockRuntime
