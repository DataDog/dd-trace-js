'use strict'

const LLMObsPlugin = require('../base')
const {
  extractInputMessages,
  extractMetrics,
  extractOutputMessages,
  extractToolDefinitions,
  getModelProvider,
  joinChunks,
} = require('./util')

// SDK request field -> LLMObs metadata key (dd-trace-py `GENERATE_METADATA_PARAMS`)
const CHAT_METADATA_PARAMS = [
  ['temperature', 'temperature'],
  ['topP', 'top_p'],
  ['maxTokens', 'max_tokens'],
  ['stop', 'stop'],
  ['randomSeed', 'random_seed'],
  ['responseFormat', 'response_format'],
  ['presencePenalty', 'presence_penalty'],
  ['frequencyPenalty', 'frequency_penalty'],
  ['n', 'n'],
  ['parallelToolCalls', 'parallel_tool_calls'],
  ['reasoningEffort', 'reasoning_effort'],
  ['promptMode', 'prompt_mode'],
  ['guardrails', 'guardrails'],
  ['safePrompt', 'safe_prompt'],
]

// dd-trace-py `EMBED_METADATA_PARAMS`
const EMBEDDING_METADATA_PARAMS = [
  ['outputDimension', 'output_dimension'],
  ['outputDtype', 'output_dtype'],
  ['encodingFormat', 'encoding_format'],
]

class MistralAILLMObsPlugin extends LLMObsPlugin {
  static integration = 'mistralai' // used for llmobs telemetry
  static id = 'mistralai'
  static prefix = 'tracing:apm:mistralai:request'

  constructor () {
    super(...arguments)

    this.addSub('apm:mistralai:request:chunk', ({ ctx, chunk, done }) => {
      ctx.chunks ??= []
      if (chunk) ctx.chunks.push(chunk)

      if (!done) return

      ctx.result = joinChunks(ctx.chunks)
    })
  }

  getLLMObsSpanRegisterOptions (ctx) {
    const { request, resource, serverURL } = ctx

    return {
      kind: resource === 'Embeddings.create' ? 'embedding' : 'llm',
      modelName: request?.model,
      modelProvider: getModelProvider(serverURL),
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const { request, resource, result } = ctx

    if (resource === 'Embeddings.create') {
      this.#tagEmbedding(span, request, result)
    } else {
      this.#tagChat(span, request, result)
    }
  }

  #tagChat (span, request, response) {
    if (response?.model) this._tagger.tagModelName(span, response.model)

    this.#tagMetadata(span, request, CHAT_METADATA_PARAMS)
    this._tagger.tagLLMIO(span, extractInputMessages(request?.messages), extractOutputMessages(response))
    this._tagger.tagMetrics(span, extractMetrics(response))

    const toolDefinitions = extractToolDefinitions(request?.tools)
    if (toolDefinitions) this._tagger.tagToolDefinitions(span, toolDefinitions)
  }

  #tagEmbedding (span, request, response) {
    if (response?.model) this._tagger.tagModelName(span, response.model)

    this.#tagMetadata(span, request, EMBEDDING_METADATA_PARAMS)

    let inputs = request?.inputs ?? ''
    if (!Array.isArray(inputs)) inputs = [inputs]
    const inputDocuments = inputs.map(input => ({ text: String(input) }))

    const data = response?.data
    let outputValue = ''
    if (Array.isArray(data) && data.length > 0) {
      outputValue = `[${data.length} embedding(s) returned with size ${data[0]?.embedding?.length ?? 0}]`
    }

    this._tagger.tagEmbeddingIO(span, inputDocuments, outputValue)
    this._tagger.tagMetrics(span, extractMetrics(response))
  }

  #tagMetadata (span, request, params) {
    if (request == null) return

    const metadata = {}
    for (const [requestKey, metadataKey] of params) {
      const value = request[requestKey]
      if (value != null) metadata[metadataKey] = value
    }

    this._tagger.tagMetadata(span, metadata)
  }
}

module.exports = MistralAILLMObsPlugin
