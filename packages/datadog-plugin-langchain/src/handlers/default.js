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

  // no-op for default handler
  extractApiKey (instance) {}

  // no-op for default handler
  extractProvider (instance) {}

  // no-op for default handler
  extractModel (instance) {}

  normalize (text) {
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
