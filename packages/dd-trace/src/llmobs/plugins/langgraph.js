'use strict'

const LLMObsPlugin = require('./base')

const ALLOWED_METADATA_KEYS = new Set([
  'recursionLimit',
  'runName',
  'tags',
  'maxConcurrency'
])

class LangchainLanggraphLLMObsPlugin extends LLMObsPlugin {
  static integration = 'langgraph'
  static id = 'llmobs_langgraph'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_invoke'

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

    this.#tagInput(span, input)

    if (!error) {
      this.#tagOutput(span, result)
    }

    this.#tagMetadata(span, config)
  }

  #tagInput (span, input) {
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

  #tagOutput (span, result) {
    if (result === undefined || result === null) return

    try {
      const outputStr = typeof result === 'string' ? result : JSON.stringify(result)
      this._tagger.tagTextIO(span, null, outputStr)
    } catch {
      this._tagger.tagTextIO(span, null, '[Unable to serialize output]')
    }
  }

  #tagMetadata (span, config) {
    if (!config || typeof config !== 'object') {
      this._tagger.tagMetadata(span, {})
      return
    }

    const metadata = {}

    for (const [key, value] of Object.entries(config)) {
      if (!ALLOWED_METADATA_KEYS.has(key)) continue
      if (!this.#isAllowedValue(value)) continue

      metadata[key] = value
    }

    this._tagger.tagMetadata(span, metadata)
  }

  #isAllowedValue (value) {
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

module.exports = LangchainLanggraphLLMObsPlugin
