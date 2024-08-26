'use strict'

const BaseLLMObsIntegration = require('./base')

const { getMlApp, getSessionId } = require('../util')
const {
  MODEL_NAME,
  INPUT_TOKENS_METRIC_KEY,
  OUTPUT_TOKENS_METRIC_KEY,
  TOTAL_TOKENS_METRIC_KEY
} = require('../constants')

class OpenAIIntegration extends BaseLLMObsIntegration {
  get name () {
    return 'openai'
  }

  setSpanStartTags (span, resource, inputs) {
    const methodName = this._gateResource(this._normalizeOpenAIResourceName(resource))
    if (!methodName) return // we will not trace all openai methods for llmobs

    const name = `openai.${methodName}`

    const operation = this._getOperation(methodName)
    const kind = operation === 'embedding' ? 'embedding' : 'llm'

    this._tagger.setLLMObsSpanTags(span, kind, {
      modelProvider: 'openai',
      mlApp: getMlApp(span, this._config.llmobs.mlApp),
      sessionId: getSessionId(span)
    }, name)

    if (operation === 'completion') {
      this._tagCompletionStart(span, inputs)
    } else if (operation === 'chat') {
      this._tagChatCompletionStart(span, inputs)
    } else if (operation === 'embedding') {
      this._tagEmbeddingStart(span, inputs)
    }
  }

  // this should not care about if the response was streamed or not
  setSpanEndTags (span, resource, response, error) {
    const methodName = this._gateResource(this._normalizeOpenAIResourceName(resource))
    if (!methodName) return // we will not trace all openai methods for llmobs

    const operation = this._getOperation(methodName)

    if (operation === 'completion') {
      this._tagCompletionEnd(span, response, error)
    } else if (operation === 'chat') {
      this._tagChatCompletionEnd(span, response, error)
    } else if (operation === 'embedding') {
      this._tagEmbeddingEnd(span, response, error)
    }

    const tags = span.context()._tags
    this._tagger.tagMetrics(span, {
      [INPUT_TOKENS_METRIC_KEY]: tags['openai.response.usage.prompt_tokens'],
      [OUTPUT_TOKENS_METRIC_KEY]: tags['openai.response.usage.completion_tokens'],
      [TOTAL_TOKENS_METRIC_KEY]: tags['openai.response.usage.total_tokens']
    })
  }

  _tagEmbeddingStart (span, inputs) {
    const { model, ...parameters } = inputs
    if (model) span.setTag(MODEL_NAME, model)

    const metadata = {
      encoding_format: parameters.encoding_format || 'float'
    }
    if (inputs.dimensions) metadata.dimensions = inputs.dimensions
    this._tagger.tagMetadata(span, metadata)

    let embeddingInputs = inputs.input
    if (!Array.isArray(embeddingInputs)) embeddingInputs = [embeddingInputs]
    this._tagger.tagEmbeddingIO(span, embeddingInputs.map(input => ({ text: input })), undefined)
  }

  _tagEmbeddingEnd (span, response, error) {
    if (!error) {
      const float = Array.isArray(response.data[0].embedding)
      if (float) {
        const embeddingDim = response.data[0].embedding.length
        this._tagger.tagEmbeddingIO(
          span, undefined, `[${response.data.length} embedding(s) returned with size ${embeddingDim}]`
        )
        return
      }

      this._tagger.tagEmbeddingIO(span, undefined, `[${response.data.length} embedding(s) returned]`)
    }
  }

  _tagCompletionStart (span, inputs) {
    let { prompt, model, ...parameters } = inputs
    if (!Array.isArray(prompt)) prompt = [prompt]
    if (model) span.setTag(MODEL_NAME, model)

    this._tagger.tagLLMIO(span, prompt.map(p => ({ content: p })), undefined)
    this._tagger.tagMetadata(span, parameters)
  }

  _tagCompletionEnd (span, response, error) {
    if (error) {
      this._tagger.tagLLMIO(span, undefined, [{ content: '' }])
      return
    }

    this._tagger.tagLLMIO(span, undefined, response.choices.map(choice => ({ content: choice.text })))
  }

  _tagChatCompletionEnd (span, response, error) {
    if (error) {
      this._tagger.tagLLMIO(span, undefined, [{ content: '' }])
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
        outputMessages.push({ content, role, tool_calls: [functionCallInfo] })
      } else if (message.tool_calls) {
        const toolCallsInfo = []
        for (const toolCall of message.tool_calls) {
          const toolCallInfo = {
            ...toolCall,
            arguments: JSON.parse(toolCall.function.arguments)
            // name: toolCall.function.name,
          }
          toolCallsInfo.push(toolCallInfo)
        }
        outputMessages.push({ content, role, tool_calls: toolCallsInfo })
      } else {
        outputMessages.push({ content, role })
      }
    }

    this._tagger.tagLLMIO(span, undefined, outputMessages)
  }

  _tagChatCompletionStart (span, inputs) {
    const { messages, model, ...parameters } = inputs
    this._tagger.tagLLMIO(span, messages, undefined) // no output data
    if (model) span.setTag(MODEL_NAME, model)

    const metadata = Object.entries(parameters).reduce((obj, [key, value]) => {
      if (!['tools', 'functions'].includes(key)) {
        obj[key] = value
      }

      return obj
    }, {})

    this._tagger.tagMetadata(span, metadata)
  }

  _isEmbeddingOperation (resource) {
    return resource === 'createEmbedding'
  }

  // TODO: this will be moved to the APM integration
  _normalizeOpenAIResourceName (resource) {
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

  _gateResource (resource) {
    return ['createCompletion', 'createChatCompletion', 'createEmbedding'].includes(resource)
      ? resource
      : undefined
  }

  _getOperation (resource) {
    switch (resource) {
      case 'createCompletion':
        return 'completion'
      case 'createChatCompletion':
        return 'chat'
      case 'createEmbedding':
        return 'embedding'
      default:
        return 'unknown'
    }
  }
}

module.exports = OpenAIIntegration
