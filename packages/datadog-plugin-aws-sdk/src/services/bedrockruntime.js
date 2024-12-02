'use strict'

const BaseAwsSdkPlugin = require('../base')
const log = require('../../../dd-trace/src/log')

const _AI21 = 'ai21'
const _AMAZON = 'amazon'
const _ANTHROPIC = 'anthropic'
const _COHERE = 'cohere'
const _META = 'meta'
const _STABILITY = 'stability'

class BedrockRuntime extends BaseAwsSdkPlugin {
  static get id () { return 'bedrock runtime' }

  generateTags (params, operation, response) {
    let tags = {}
    let modelName = ''
    let modelProvider = ''
    const modelMeta = params.modelId.split('.')
    if (modelMeta.length === 2) {
      [modelProvider, modelName] = modelMeta
    } else {
      [, modelProvider, modelName] = modelMeta
    }

    const shouldSetChoiceIds = modelProvider === 'COHERE' && !modelName.includes('embed')

    const requestParams = extractRequestParams(params, modelProvider)
    const textAndResponseReasons = extractTextAndResponseReason(response, modelProvider, modelName, shouldSetChoiceIds)

    tags = buildTagsFromParams(requestParams, textAndResponseReasons, modelProvider, modelName, operation)

    console.log(tags)

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

function extractTextAndResponseReason (response, provider, modelName, shouldSetChoiceIds) {
  const body = JSON.parse(Buffer.from(response.body).toString('utf8'))
  let text = ''
  let finishReason = ''
  let choiceId = ''

  try {
    if (provider === 'AI21') {
      const completions = body.completions || []
      if (completions.length > 0) {
        const data = completions[0].data || {}
        text = data.text
        finishReason = completions[0].finishReason
      }
    } else if (provider === 'AMAZON' && modelName.includes('embed')) {
      text = [body.embedding || []]
    } else if (provider === 'AMAZON') {
      const results = body.results || []
      if (results.length > 0) {
        text = results[0].outputText
        finishReason = results[0].completionReason
      }
    } else if (provider === 'ANTHROPIC') {
      text = body.completion || body.content || ''
      finishReason = body.stop_reason
    } else if (provider === 'COHERE' && modelName.includes('embed')) {
      text = body.embeddings || [[]]
    } else if (provider === 'COHERE') {
      const generations = body.generations || []
      text = generations.map(generation => generation.text)
      finishReason = generations.map(generation => generation.finish_reason)
    } else if (provider === 'META') {
      text = body.generation
      finishReason = body.stop_reason
    } else if (provider === 'STABILITY') {
      // TODO: request/response formats are different for image-based models. Defer for now
    }
    if (shouldSetChoiceIds) {
      choiceId = body.generations.map(generation => generation.id)
    }
  } catch (error) {
    log.error('Unable to extract text/finish_reason from response body. Defaulting to empty text/finish_reason.')
    if (!(Array.isArray(text))) {
      text = [text]
    }
    if (!(Array.isArray(finishReason))) {
      finishReason = [finishReason]
    }
  }

  if (!Array.isArray(text)) {
    text = [text]
  }
  if (!Array.isArray(finishReason)) {
    finishReason = [finishReason]
  }

  if (shouldSetChoiceIds) {
    return { text, finish_reason: finishReason, choice_id: choiceId }
  }

  return { text, finish_reason: finishReason }
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
  Object.entries(textAndResponseReasons).forEach(([key, value]) => {
    console.log(textAndResponseReason, index)
    if (modelName.includes('embed')) {
      tags['aws.bedrock.response.embedding_length'] = textAndResponseReason.text[0].length
    }
    if (textAndResponseReason.choice_id) {
      tags[`aws.bedrock.response.choices.${index}.id`] = textAndResponseReason.choice_id[index]
    }
    tags[`aws.bedrock.response.choices.${index}.text`] = textAndResponseReason.text[index]
    tags[`aws.bedrock.response.choices.${index}.finish_reason`] = textAndResponseReason.finish_reason[index]
  })

  return tags
}

module.exports = BedrockRuntime
