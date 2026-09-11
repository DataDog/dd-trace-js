'use strict'

const LLMObsPlugin = require('../base')
const {
  getOperation,
  extractMetrics,
  extractMetadata,
  extractToolDefinitions,
  aggregateStreamingChunks,
  formatInputMessages,
  formatEmbeddingInput,
  formatOutputMessages,
  formatEmbeddingOutput,
} = require('./util')

class GenAiLLMObsPlugin extends LLMObsPlugin {
  static id = 'google-genai'
  static integration = 'google_genai'
  static prefix = 'tracing:apm:google:genai:request'

  constructor () {
    super(...arguments)

    // Subscribe to streaming chunk events
    this.addSub('apm:google:genai:request:chunk', ({ ctx, chunk, done }) => {
      if (!this._llmobsEnabled) {
        // only the token usage is needed, for the `gen_ai.usage.*` metrics. The aggregated
        // response is left alone: it feeds the LLMObs payload and `google_genai.response.model`.
        if (chunk?.usageMetadata) ctx.streamedUsageMetadata = chunk.usageMetadata
        return
      }

      ctx.isStreaming = true
      ctx.chunks ||= []

      if (chunk) ctx.chunks.push(chunk)
      if (!done) return

      // Aggregate streaming chunks into a single response
      ctx.result = aggregateStreamingChunks(ctx.chunks)
    })
  }

  getLLMObsSpanRegisterOptions (ctx) {
    const { args, methodName } = ctx
    if (!methodName) return

    const inputs = args[0]
    const operation = getOperation(methodName)

    return {
      modelProvider: 'google',
      modelName: inputs.model,
      kind: operation,
      name: 'google_genai.request',
    }
  }

  /**
   * @override
   */
  getGenAiApmEndTags (ctx) {
    return { metrics: extractMetrics(ctx.result ?? { usageMetadata: ctx.streamedUsageMetadata }) }
  }

  setLLMObsTags (ctx) {
    const { args, methodName } = ctx
    const span = ctx.currentStore?.span
    if (!methodName) return

    const inputs = args[0]
    const response = ctx.result
    const error = !!span.context().getTag('error')

    const operation = getOperation(methodName)

    if (operation === 'llm') {
      this.#tagGenerateContent(span, inputs, response, error, ctx.isStreaming)
    } else if (operation === 'embedding') {
      this.#tagEmbedding(span, inputs, response, error)
    }

    if (!error && response) {
      const metrics = extractMetrics(response)
      this._tagger.tagMetrics(span, metrics)
    }
  }

  #tagGenerateContent (span, inputs, response, error, isStreaming = false) {
    const { config = {} } = inputs

    const inputMessages = formatInputMessages(inputs.contents)

    const metadata = extractMetadata(config)
    this._tagger.tagMetadata(span, metadata)

    const toolDefinitions = extractToolDefinitions(config)
    if (toolDefinitions.length > 0) this._tagger.tagToolDefinitions(span, toolDefinitions)

    if (error) {
      this._tagger.tagLLMIO(span, inputMessages, [{ content: '' }])
      return
    }

    const outputMessages = formatOutputMessages(response, isStreaming)
    this._tagger.tagLLMIO(span, inputMessages, outputMessages)
  }

  #tagEmbedding (span, inputs, response, error) {
    const embeddingInput = formatEmbeddingInput(inputs.contents)

    if (error) {
      this._tagger.tagEmbeddingIO(span, embeddingInput)
      return
    }

    const embeddingOutput = formatEmbeddingOutput(response)
    this._tagger.tagEmbeddingIO(span, embeddingInput, embeddingOutput)
  }
}

module.exports = GenAiLLMObsPlugin
