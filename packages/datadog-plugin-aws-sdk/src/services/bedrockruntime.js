'use strict'

const BaseAwsSdkPlugin = require('../base')
const log = require('../../../dd-trace/src/log')

const AI21 = 'ai21'
const AMAZON = 'amazon'
const ANTHROPIC = 'anthropic'
const COHERE = 'cohere'
const META = 'meta'
const STABILITY = 'stability'

class BedrockRuntime extends BaseAwsSdkPlugin {
  static get id () { return 'bedrock runtime' }

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

    const shouldSetChoiceIds = modelProvider === 'COHERE' && !modelName.includes('embed')

    const requestParams = extractRequestParams(params, modelProvider)
    const textAndResponseReasons = extractTextAndResponseReason(response, modelProvider, modelName, shouldSetChoiceIds)

    tags = buildTagsFromParams(requestParams, textAndResponseReasons, modelProvider, modelName, operation)

    tags = Object.fromEntries(Object.entries(tags).filter(([_, v]) => v !== undefined))

    return tags
  }
}

function extractRequestParams (params, provider) {
  const requestBody = JSON.parse(params.body)
  const modelId = params.modelId

  if (provider === AI21) {
    return {
      prompt: requestBody.prompt,
      temperature: requestBody.temperature || '',
      top_p: requestBody.topP || '',
      max_tokens: requestBody.maxTokens || '',
      stop_sequences: requestBody.stopSequences || []
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
  } else if (provider === STABILITY) {
    // TODO: request/response formats are different for image-based models. Defer for now
    return {}
  }
  return {}
}

function extractTextAndResponseReason (response, provider, modelName, shouldSetChoiceIds) {
  const body = JSON.parse(Buffer.from(response.body).toString('utf8'))
  const textAndResponseReasons = []

  try {
    if (provider === 'AI21') {
      const completions = body.completions || []
      completions.forEach(completion => {
        textAndResponseReasons.push({
          text: completion.data ? completion.data.text : '',
          finish_reason: completion.finishReason || '',
          choice_id: shouldSetChoiceIds ? completion.id : undefined
        })
      })
    } else if (provider === 'AMAZON' && modelName.includes('embed')) {
      textAndResponseReasons.push({
        text: body.embedding || [],
        finish_reason: '',
        choice_id: undefined
      })
    } else if (provider === 'AMAZON') {
      (body.results || []).forEach(result => {
        textAndResponseReasons.push({
          text: result.outputText || '',
          finish_reason: result.completionReason || '',
          choice_id: undefined
        })
      })
    } else if (provider === 'ANTHROPIC') {
      textAndResponseReasons.push({
        text: body.completion || body.content || '',
        finish_reason: body.stop_reason || '',
        choice_id: undefined
      })
    } else if (provider === 'COHERE' && modelName.includes('embed')) {
      (body.embeddings || [[]]).forEach(embedding => {
        textAndResponseReasons.push({
          text: embedding,
          finish_reason: '',
          choice_id: undefined
        })
      })
    } else if (provider === 'COHERE') {
      const generations = body.generations || []
      generations.forEach(generation => {
        textAndResponseReasons.push({
          text: generation.text,
          finish_reason: generation.finish_reason,
          choice_id: shouldSetChoiceIds ? generation.id : undefined
        })
      })
    } else if (provider === 'META') {
      textAndResponseReasons.push({
        text: body.generation || '',
        finish_reason: body.stop_reason || '',
        choice_id: undefined
      })
    } else if (provider === 'STABILITY') {
      // TODO: request/response formats are different for image-based models. Defer for now
    }
  } catch (error) {
    log.error('Unable to extract text/finish_reason from response body. Defaulting to empty text/finish_reason.')
    textAndResponseReasons.push({
      text: '',
      finish_reason: '',
      choice_id: undefined
    })
  }

  return textAndResponseReasons
}

function buildTagsFromParams (requestParams, textAndResponseReasons, modelProvider, modelName, operation) {
  const tags = {}

  // add request tags
  tags['resource.name'] = `${operation}`
  tags['aws.bedrock.request.model'] = modelName
  tags['aws.bedrock.request.model_provider'] = modelProvider
  tags['aws.bedrock.request.prompt'] = requestParams.prompt
  tags['aws.bedrock.request.temperature'] = requestParams.temperature
  tags['aws.bedrock.request.top_p'] = requestParams.top_p
  tags['aws.bedrock.request.max_tokens'] = requestParams.max_tokens
  tags['aws.bedrock.request.stop_sequences'] = requestParams.stop_sequences

  // add response tags
  textAndResponseReasons.forEach((textAndResponseReason, index) => {
    if (modelName.includes('embed')) {
      tags['aws.bedrock.response.embedding_length'] = textAndResponseReason.text.length
    }
    if (textAndResponseReason.choice_id) {
      tags[`aws.bedrock.response.choices.${index}.id`] = textAndResponseReason.choice_id
    }
    tags[`aws.bedrock.response.choices.${index}.text`] = textAndResponseReason.text
    tags[`aws.bedrock.response.choices.${index}.finish_reason`] = textAndResponseReason.finish_reason
  })

  return tags
}

module.exports = BedrockRuntime
