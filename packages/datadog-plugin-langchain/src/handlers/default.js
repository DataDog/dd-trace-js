'use strict'

const Sampler = require('../../../dd-trace/src/sampler')

const RE_NEWLINE = /\n/g
const RE_TAB = /\t/g

// TODO: should probably refactor the OpenAI integration to use a shared LLMTracingPlugin base class
// This logic isn't particular to LangChain
class LangChainHandler {
  constructor (config) {
    this.config = config
    this.sampler = new Sampler(config.spanPromptCompletionSampleRate)
  }

  // no-op for default handler
  getSpanStartTags (ctx) {}

  // no-op for default handler
  getSpanEndTags (ctx) {}

  extractApiKey (instance) {
    const key = Object.keys(instance)
      .find(key => {
        const lower = key.toLowerCase()
        return lower.includes('apikey') || lower.includes('apitoken')
      })

    let apiKey = instance[key]
    if (apiKey?.secretValue && typeof apiKey.secretValue === 'function') {
      apiKey = apiKey.secretValue()
    }
    if (!apiKey || apiKey.length < 4) return ''
    return `...${apiKey.slice(-4)}`
  }

  extractProvider (instance) {
    return typeof instance._llmType === 'function' && instance._llmType().split('-')[0]
  }

  extractModel (instance) {
    for (const attr of ['model', 'modelName', 'modelId', 'modelKey', 'repoId']) {
      const modelName = instance[attr]
      if (modelName) return modelName
    }
  }

  truncate (text) {
    if (!text) return
    if (typeof text !== 'string' || !text || (typeof text === 'string' && text.length === 0)) return

    const max = this.config.spanCharLimit

    text = text
      .replace(RE_NEWLINE, '\\n')
      .replace(RE_TAB, '\\t')

    if (text.length > max) {
      return text.substring(0, max) + '...'
    }

    return text
  }

  isPromptCompletionSampled () {
    return this.sampler.isSampled()
  }
}

module.exports = LangChainHandler
