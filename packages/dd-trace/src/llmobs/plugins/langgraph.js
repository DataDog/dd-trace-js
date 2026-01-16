'use strict'

const LLMObsPlugin = require('./base')

// Metadata keys that are safe to capture from LangGraph config
const ALLOWED_METADATA_KEYS = new Set([
  'recursionLimit',
  'runName',
  'tags',
  'maxConcurrency'
])

// Keys that should never be captured (may contain sensitive data)
const BLOCKED_METADATA_KEYS = new Set([
  'configurable',
  'callbacks',
  'metadata',
  'runId',
  'signal'
])

class LangchainLanggraphLLMObsPlugin extends LLMObsPlugin {
  static integration = 'langchain-langgraph'
  static id = 'langchain-langgraph'
  // Subscribe to orchestrion-based invoke channel
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_invoke'

  constructor () {
    super(...arguments)

    // Subscribe to shimmer-based stream channel for streaming support
    // The stream() method uses shimmer wrapping because it uses `super.stream()`
    // which breaks the orchestrion rewriter
    this.addSub('apm:langchain-langgraph:stream:asyncEnd', ctx => {
      ctx.isStream = true
      this.setLLMObsTags(ctx)
    })

    this.addSub('apm:langchain-langgraph:stream:start', ctx => {
      ctx.isStream = true
      this.start(ctx)
    })

    this.addSub('apm:langchain-langgraph:stream:end', ctx => {
      this.end(ctx)
    })
  }

  getLLMObsSpanRegisterOptions (ctx) {
    return {
      kind: 'workflow',
      modelName: 'langchain-langgraph',
      modelProvider: 'langchain'
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const { result, error, isStream } = ctx
    // Orchestrion rewriter uses `arguments`, shimmer uses `args`
    const args = ctx.arguments || ctx.args

    // Extract input from first argument (state input)
    const input = args?.[0]
    // Extract config options from second argument
    const config = args?.[1]

    // Tag input value
    this.#tagInputValue(span, input)

    // Tag output value (only if no error)
    if (!error) {
      this.#tagOutputValue(span, result, isStream)
    }

    // Tag metadata from config
    this.#tagMetadata(span, config)
  }

  #tagInputValue (span, input) {
    // Handle null/undefined by serializing them as JSON strings
    // This ensures we always have an input value for workflow spans
    if (input === undefined) {
      this._tagger.tagTextIO(span, 'undefined', undefined)
      return
    }

    if (input === null) {
      this._tagger.tagTextIO(span, 'null', undefined)
      return
    }

    try {
      const inputStr = typeof input === 'string' ? input : JSON.stringify(input)
      this._tagger.tagTextIO(span, inputStr, undefined)
    } catch {
      this._tagger.tagTextIO(span, '[Unable to serialize input]', undefined)
    }
  }

  #tagOutputValue (span, result, isStream) {
    if (result === undefined || result === null) {
      return
    }

    try {
      const outputStr = typeof result === 'string' ? result : JSON.stringify(result)
      this._tagger.tagTextIO(span, undefined, outputStr)
    } catch {
      this._tagger.tagTextIO(span, undefined, '[Unable to serialize output]')
    }
  }

  #tagMetadata (span, config) {
    if (!config || typeof config !== 'object') {
      this._tagger.tagMetadata(span, {})
      return
    }

    const metadata = {}

    for (const [key, value] of Object.entries(config)) {
      // Skip blocked keys
      if (BLOCKED_METADATA_KEYS.has(key)) {
        continue
      }

      // Only include allowed keys
      if (ALLOWED_METADATA_KEYS.has(key)) {
        // Only include primitive values or arrays of primitives
        if (this.#isAllowedValue(value)) {
          metadata[key] = value
        }
      }
    }

    this._tagger.tagMetadata(span, metadata)
  }

  #isAllowedValue (value) {
    if (value === null || value === undefined) {
      return false
    }

    const type = typeof value
    if (type === 'string' || type === 'number' || type === 'boolean') {
      return true
    }

    if (Array.isArray(value)) {
      return value.every(item => {
        const itemType = typeof item
        return itemType === 'string' || itemType === 'number' || itemType === 'boolean'
      })
    }

    return false
  }
}

module.exports = LangchainLanggraphLLMObsPlugin
