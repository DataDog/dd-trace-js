'use strict'

const LLMObsPlugin = require('./base')

const ALLOWED_METADATA_KEYS = new Set([
  'recursionLimit',
  'runName',
  'tags',
  'maxConcurrency'
])

/**
 * Base class for LangGraph LLMObs plugins with shared tagging logic.
 */
class LangchainLanggraphBaseLLMObsPlugin extends LLMObsPlugin {
  static integration = 'langgraph'

  getLLMObsSpanRegisterOptions () {
    return {
      kind: 'workflow',
      modelName: 'langgraph',
      modelProvider: 'langchain'
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const { result, error } = ctx
    const args = ctx.arguments || ctx.args

    const input = args?.[0]
    const config = args?.[1]

    this._tagInput(span, input)

    if (!error) {
      this._tagOutput(span, result)
    }

    this._tagMetadata(span, config)
  }

  _tagInput (span, input) {
    if (input === undefined) {
      this._tagger.tagTextIO(span, 'undefined')
      return
    }

    if (input === null) {
      this._tagger.tagTextIO(span, 'null')
      return
    }

    try {
      const inputStr = typeof input === 'string' ? input : JSON.stringify(input)
      this._tagger.tagTextIO(span, inputStr)
    } catch {
      this._tagger.tagTextIO(span, '[Unable to serialize input]')
    }
  }

  _tagOutput (span, result) {
    if (result === undefined || result === null) return

    try {
      // Sanitize result to exclude internal LangGraph properties
      const sanitized = this._sanitizeOutput(result)
      const outputStr = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized)
      this._tagger.tagTextIO(span, null, outputStr)
    } catch {
      this._tagger.tagTextIO(span, null, '[Unable to serialize output]')
    }
  }

  /**
   * Sanitize output object by removing internal LangGraph properties.
   * Internal properties start with underscore (e.g., _abortController, _innerReader).
   */
  _sanitizeOutput (result) {
    if (typeof result !== 'object' || result === null) {
      return result
    }

    if (Array.isArray(result)) {
      return result.map(item => this._sanitizeOutput(item))
    }

    const sanitized = {}
    for (const [key, value] of Object.entries(result)) {
      // Skip internal properties (start with _)
      if (key.startsWith('_')) continue
      sanitized[key] = value
    }
    return sanitized
  }

  _tagMetadata (span, config) {
    if (!config || typeof config !== 'object') {
      this._tagger.tagMetadata(span, {})
      return
    }

    const metadata = {}

    for (const [key, value] of Object.entries(config)) {
      if (!ALLOWED_METADATA_KEYS.has(key)) continue
      if (!this._isAllowedValue(value)) continue

      metadata[key] = value
    }

    this._tagger.tagMetadata(span, metadata)
  }

  _isAllowedValue (value) {
    if (value === null || value === undefined) return false

    const type = typeof value
    if (type === 'string' || type === 'number' || type === 'boolean') return true

    if (Array.isArray(value)) {
      for (const item of value) {
        const itemType = typeof item
        if (itemType !== 'string' && itemType !== 'number' && itemType !== 'boolean') {
          return false
        }
      }
      return true
    }

    return false
  }
}

/**
 * LLMObs plugin for Pregel.invoke() operations.
 */
class LangchainLanggraphInvokeLLMObsPlugin extends LangchainLanggraphBaseLLMObsPlugin {
  static id = 'llmobs_langgraph_invoke'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_invoke'
}

/**
 * LLMObs plugin for Pregel.stream() operations.
 * Consumes stream chunks and aggregates them into the final state.
 */
class LangchainLanggraphStreamLLMObsPlugin extends LangchainLanggraphBaseLLMObsPlugin {
  static id = 'llmobs_langgraph_stream'
  static prefix = 'tracing:apm:langgraph:stream'

  constructor () {
    super(...arguments)

    // Subscribe to streaming chunk events
    this.addSub('apm:langgraph:stream:chunk', ({ ctx, chunk, done }) => {
      ctx.isStreaming = true
      ctx.chunks = ctx.chunks || []

      if (chunk) ctx.chunks.push(chunk)
      if (!done) return

      // Aggregate streaming chunks into final state
      // LangGraph chunks are objects like { nodeName: stateUpdate }
      // We merge them to reconstruct the final state
      ctx.result = this._aggregateChunks(ctx.chunks)
    })
  }

  /**
   * Aggregates LangGraph stream chunks into final state.
   * Each chunk is an object like { nodeName: { stateKey: value, ... } }
   * We merge all the state updates to get the final state.
   */
  _aggregateChunks (chunks) {
    const finalState = {}

    for (const chunk of chunks) {
      // Each chunk is { nodeName: stateUpdate }
      // We need to merge the state updates
      for (const nodeOutput of Object.values(chunk)) {
        if (nodeOutput && typeof nodeOutput === 'object') {
          Object.assign(finalState, nodeOutput)
        }
      }
    }

    return finalState
  }
}

module.exports = {
  LangchainLanggraphInvokeLLMObsPlugin,
  LangchainLanggraphStreamLLMObsPlugin
}
