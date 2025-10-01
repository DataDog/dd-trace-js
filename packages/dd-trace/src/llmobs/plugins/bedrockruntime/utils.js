'use strict'

const log = require('../../../log')

const PROVIDER = {
  AI21: 'AI21',
  AMAZON: 'AMAZON',
  ANTHROPIC: 'ANTHROPIC',
  COHERE: 'COHERE',
  META: 'META',
  STABILITY: 'STABILITY',
  MISTRAL: 'MISTRAL'
}

/**
 * Coerce the chunks into a single response body.
 *
 * @param {Array<{ chunk: { bytes: Buffer } }>} chunks
 * @param {string} provider
 * @returns {Object}
 */
function extractTextAndResponseReasonFromStream (chunks, modelProvider, modelName) {
  const modelProviderUpper = modelProvider.toUpperCase()

  // streaming unsupported for AMAZON embedding models, COHERE embedding models, STABILITY
  if (
    (modelProviderUpper === PROVIDER.AMAZON && modelName.includes('embed')) ||
    (modelProviderUpper === PROVIDER.COHERE && modelName.includes('embed')) ||
    modelProviderUpper === PROVIDER.STABILITY
  ) {
    return {}
  }

  let message = ''
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0

  for (const { chunk: { bytes } } of chunks) {
    const body = JSON.parse(Buffer.from(bytes).toString('utf8'))

    switch (modelProviderUpper) {
      case PROVIDER.AMAZON: {
        message += body?.outputText

        inputTokens = body?.inputTextTokenCount
        outputTokens = body?.totalOutputTextTokenCount

        break
      }
      case PROVIDER.AI21: {
        const content = body?.choices?.[0]?.delta?.content
        if (content) {
          message += content
        }

        break
      }
      case PROVIDER.ANTHROPIC: {
        if (body.completion) {
          message += body.completion
        } else if (body.delta?.text) {
          message += body.delta.text
        }

        if (body.message?.usage?.input_tokens) inputTokens = body.message.usage.input_tokens
        if (body.message?.usage?.output_tokens) outputTokens = body.message.usage.output_tokens

        break
      }
      case PROVIDER.COHERE: {
        if (body?.event_type === 'stream-end') {
          message = body.response?.text
        }

        break
      }
      case PROVIDER.META: {
        message += body?.generation
        break
      }
      case PROVIDER.MISTRAL: {
        message += body?.outputs?.[0]?.text
        break
      }
    }

    // by default, it seems newer versions of the AWS SDK include the input/output token counts in the response body
    const invocationMetrics = body['amazon-bedrock-invocationMetrics']
    if (invocationMetrics) {
      inputTokens = invocationMetrics.inputTokenCount
      outputTokens = invocationMetrics.outputTokenCount
      cacheReadTokens = invocationMetrics.cacheReadInputTokenCount
      cacheWriteTokens = invocationMetrics.cacheWriteInputTokenCount
    }
  }

  return new Generation({
    message,
    role: 'assistant',
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens
  })
}

class Generation {
  constructor ({
    message = '',
    finishReason = '',
    choiceId = '',
    role,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens
  } = {}) {
    // stringify message as it could be a single generated message as well as a list of embeddings
    this.message = typeof message === 'string' ? message : JSON.stringify(message) || ''
    this.finishReason = finishReason || ''
    this.choiceId = choiceId || undefined
    this.role = role
    this.usage = {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens
    }
  }
}

class RequestParams {
  constructor ({
    prompt = '',
    temperature,
    topP,
    topK,
    maxTokens,
    stopSequences = [],
    inputType = '',
    truncate = '',
    stream = '',
    n
  } = {}) {
    // stringify prompt as it could be a single prompt as well as a list of message objects
    this.prompt = typeof prompt === 'string' ? prompt : JSON.stringify(prompt) || ''
    this.temperature = temperature === undefined ? undefined : temperature
    this.topP = topP === undefined ? undefined : topP
    this.topK = topK === undefined ? undefined : topK
    this.maxTokens = maxTokens === undefined ? undefined : maxTokens
    this.stopSequences = stopSequences || []
    this.inputType = inputType || ''
    this.truncate = truncate || ''
    this.stream = stream || ''
    this.n = n === undefined ? undefined : n
  }
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
      let prompt = requestBody.prompt
      if (Array.isArray(requestBody.messages)) { // newer claude models
        for (let idx = requestBody.messages.length - 1; idx >= 0; idx--) {
          const message = requestBody.messages[idx]
          if (message.role === 'user') {
            prompt = message.content?.filter(block => block.type === 'text')
              .map(block => block.text)
              .join('')
            break
          }
        }
      }

      return new RequestParams({
        prompt,
        temperature: requestBody.temperature,
        topP: requestBody.top_p,
        maxTokens: requestBody.max_tokens_to_sample ?? requestBody.max_tokens,
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
        let message = body.completion
        if (Array.isArray(body.content)) { // newer claude models
          message = body.content.find(item => item.type === 'text')?.text ?? body.content
        } else if (body.content) {
          message = body.content
        }
        return new Generation({ message, finishReason: body.stop_reason })
      }
      case PROVIDER.COHERE: {
        if (modelName.includes('embed')) {
          const embeddings = body.embeddings || [[]]
          if (embeddings.length > 0) {
            return new Generation({ message: embeddings[0] })
          }
        }

        if (body.text) {
          return new Generation({
            message: body.text,
            finishReason: body.finish_reason,
            choiceId: shouldSetChoiceIds ? body.response_id : undefined
          })
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
  } catch {
    log.warn('Unable to extract text/finishReason from response body. Defaulting to empty text/finishReason.')
    return new Generation()
  }

  return new Generation()
}

module.exports = {
  Generation,
  RequestParams,
  extractTextAndResponseReasonFromStream,
  extractRequestParams,
  extractTextAndResponseReason,
  PROVIDER
}
