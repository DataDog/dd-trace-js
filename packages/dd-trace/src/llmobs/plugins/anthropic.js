'use strict'

const LLMObsPlugin = require('./base')

class AnthropicLLMObsPlugin extends LLMObsPlugin {
  static id = 'anthropic'
  static integration = 'anthropic'
  static prefix = 'tracing:apm:anthropic:request'

  getLLMObsSpanRegisterOptions (ctx) {
    const resource = ctx.methodName
    const methodName = normalizeAnthropicResourceName(resource)
    if (!methodName) return // we will not trace all anthropic methods for llmobs

    const inputs = ctx.args[0] // message creation takes one argument
    const operation = 'chat' // Anthropic primarily does chat completions
    const kind = 'llm'

    const { modelProvider, client } = this._getModelProviderAndClient()

    const name = `${client}.${methodName}`

    return {
      modelProvider,
      modelName: inputs.model,
      kind,
      name
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    const resource = ctx.methodName
    const methodName = normalizeAnthropicResourceName(resource)
    if (!methodName) return // we will not trace all anthropic methods for llmobs

    const inputs = ctx.args[0] // message creation takes one argument
    const response = ctx.result?.data // no result if error
    const error = !!span.context()._tags.error

    if (methodName === 'createMessage') {
      this._tagChatCompletion(span, inputs, response, error)
    }

    if (!error) {
      const metrics = this._extractMetrics(response)
      this._tagger.tagMetrics(span, metrics)
    }
  }

  _getModelProviderAndClient () {
    return { modelProvider: 'anthropic', client: 'Anthropic' }
  }

  _extractMetrics (response) {
    const metrics = {}
    const tokenUsage = response.usage

    if (tokenUsage) {
      const inputTokens = tokenUsage.input_tokens
      if (inputTokens) metrics.inputTokens = inputTokens

      const outputTokens = tokenUsage.output_tokens
      if (outputTokens) metrics.outputTokens = outputTokens

      const totalTokens = inputTokens + outputTokens
      if (totalTokens) metrics.totalTokens = totalTokens
    }

    return metrics
  }

  _tagChatCompletion (span, inputs, response, error) {
    const { model, messages, max_tokens, temperature, ...parameters } = inputs

    const metadata = {}
    if (max_tokens) metadata.max_tokens = max_tokens
    if (temperature !== undefined) metadata.temperature = temperature
    if (parameters.top_p !== undefined) metadata.top_p = parameters.top_p
    if (parameters.top_k !== undefined) metadata.top_k = parameters.top_k

    this._tagger.tagMetadata(span, metadata)

    if (messages) {
      this._tagger.tagLLMIO(span, messages, 'inputs')
    }

    if (!error && response) {
      const choices = []
      if (response.content) {
        // Anthropic returns content array
        const content = response.content
          .filter(item => item.type === 'text')
          .map(item => item.text)
          .join('')

        choices.push({
          message: {
            role: response.role,
            content: content
          },
          finish_reason: response.stop_reason
        })
      }

      this._tagger.tagLLMIO(span, choices, 'outputs')
    }
  }
}

function normalizeAnthropicResourceName (resource) {
  switch (resource) {
    case 'messages.create':
      return 'createMessage'
    default:
      return null
  }
}

module.exports = AnthropicLLMObsPlugin