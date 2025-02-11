'use strict'

const LLMObsPlugin = require('./base')

class OpenAiLLMObsPlugin extends LLMObsPlugin {
  static get prefix () {
    return 'tracing:apm:openai:request'
  }

  getLLMObsSpanRegisterOptions (ctx) {
    const resource = ctx.methodName
    const methodName = gateResource(normalizeOpenAIResourceName(resource))
    if (!methodName) return // we will not trace all openai methods for llmobs

    const inputs = ctx.args[0] // completion, chat completion, and embeddings take one argument
    const operation = getOperation(methodName)
    const kind = operation === 'embedding' ? 'embedding' : 'llm'
    const name = `openai.${methodName}`

    return {
      modelProvider: 'openai',
      modelName: inputs.model,
      kind,
      name
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    const resource = ctx.methodName
    const methodName = gateResource(normalizeOpenAIResourceName(resource))
    if (!methodName) return // we will not trace all openai methods for llmobs

    const inputs = ctx.args[0] // completion, chat completion, and embeddings take one argument
    const response = ctx.result?.data // no result if error
    const error = !!span.context()._tags.error

    const operation = getOperation(methodName)

    if (operation === 'completion') {
      this._tagCompletion(span, inputs, response, error)
    } else if (operation === 'chat') {
      this._tagChatCompletion(span, inputs, response, error)
    } else if (operation === 'embedding') {
      this._tagEmbedding(span, inputs, response, error)
    }

    if (!error) {
      const metrics = this._extractMetrics(response)
      this._tagger.tagMetrics(span, metrics)
    }
  }

  _extractMetrics (response) {
    const metrics = {}
    const tokenUsage = response.usage

    if (tokenUsage) {
      const inputTokens = tokenUsage.prompt_tokens
      if (inputTokens) metrics.inputTokens = inputTokens

      const outputTokens = tokenUsage.completion_tokens
      if (outputTokens) metrics.outputTokens = outputTokens

      const totalTokens = tokenUsage.total_toksn || (inputTokens + outputTokens)
      if (totalTokens) metrics.totalTokens = totalTokens
    }

    return metrics
  }

  _tagEmbedding (span, inputs, response, error) {
    const { model, ...parameters } = inputs

    const metadata = {
      encoding_format: parameters.encoding_format || 'float'
    }
    if (inputs.dimensions) metadata.dimensions = inputs.dimensions
    this._tagger.tagMetadata(span, metadata)

    let embeddingInputs = inputs.input
    if (!Array.isArray(embeddingInputs)) embeddingInputs = [embeddingInputs]
    const embeddingInput = embeddingInputs.map(input => ({ text: input }))

    if (error) {
      this._tagger.tagEmbeddingIO(span, embeddingInput, undefined)
      return
    }

    const float = Array.isArray(response.data[0].embedding)
    let embeddingOutput
    if (float) {
      const embeddingDim = response.data[0].embedding.length
      embeddingOutput = `[${response.data.length} embedding(s) returned with size ${embeddingDim}]`
    } else {
      embeddingOutput = `[${response.data.length} embedding(s) returned]`
    }

    this._tagger.tagEmbeddingIO(span, embeddingInput, embeddingOutput)
  }

  _tagCompletion (span, inputs, response, error) {
    let { prompt, model, ...parameters } = inputs
    if (!Array.isArray(prompt)) prompt = [prompt]

    const completionInput = prompt.map(p => ({ content: p }))

    const completionOutput = error ? [{ content: '' }] : response.choices.map(choice => ({ content: choice.text }))

    this._tagger.tagLLMIO(span, completionInput, completionOutput)
    this._tagger.tagMetadata(span, parameters)
  }

  _tagChatCompletion (span, inputs, response, error) {
    const { messages, model, ...parameters } = inputs

    if (error) {
      this._tagger.tagLLMIO(span, messages, [{ content: '' }])
      return
    }

    const outputMessages = []
    const { choices } = response
    for (const choice of choices) {
      const message = choice.message || choice.delta
      const content = message.content || ''
      const role = message.role

      if (message.function_call) {
        const functionCallInfo = {
          name: message.function_call.name,
          arguments: JSON.parse(message.function_call.arguments)
        }
        outputMessages.push({ content, role, toolCalls: [functionCallInfo] })
      } else if (message.tool_calls) {
        const toolCallsInfo = []
        for (const toolCall of message.tool_calls) {
          const toolCallInfo = {
            arguments: JSON.parse(toolCall.function.arguments),
            name: toolCall.function.name,
            toolId: toolCall.id,
            type: toolCall.type
          }
          toolCallsInfo.push(toolCallInfo)
        }
        outputMessages.push({ content, role, toolCalls: toolCallsInfo })
      } else {
        outputMessages.push({ content, role })
      }
    }

    this._tagger.tagLLMIO(span, messages, outputMessages)

    const metadata = Object.entries(parameters).reduce((obj, [key, value]) => {
      if (!['tools', 'functions'].includes(key)) {
        obj[key] = value
      }

      return obj
    }, {})

    this._tagger.tagMetadata(span, metadata)
  }
}

// TODO: this will be moved to the APM integration
function normalizeOpenAIResourceName (resource) {
  switch (resource) {
    // completions
    case 'completions.create':
      return 'createCompletion'

    // chat completions
    case 'chat.completions.create':
      return 'createChatCompletion'

    // embeddings
    case 'embeddings.create':
      return 'createEmbedding'
    default:
      return resource
  }
}

function gateResource (resource) {
  return ['createCompletion', 'createChatCompletion', 'createEmbedding'].includes(resource)
    ? resource
    : undefined
}

function getOperation (resource) {
  switch (resource) {
    case 'createCompletion':
      return 'completion'
    case 'createChatCompletion':
      return 'chat'
    case 'createEmbedding':
      return 'embedding'
    default:
      // should never happen
      return 'unknown'
  }
}

module.exports = OpenAiLLMObsPlugin
