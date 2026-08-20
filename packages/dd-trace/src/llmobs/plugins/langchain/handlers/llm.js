'use strict'

const LLMObsTagger = require('../../../tagger')
const LangChainLLMObsHandler = require('.')

class LangChainLLMObsLlmHandler extends LangChainLLMObsHandler {
  setMetaTags ({ span, inputs, results, error }) {
    const isWorkflow = LLMObsTagger.getSpanKind(span) === 'workflow'
    const prompts = Array.isArray(inputs) ? inputs : [inputs]

    let outputs
    if (error) {
      outputs = [{ content: '' }]
    } else {
      outputs = results.generations.map(completion => ({ content: completion[0].text }))

      if (!isWorkflow) {
        const tokens = this.checkTokenUsageChatOrLLMResult(results)
        this._tagger.tagMetrics(span, tokens)
      }
    }

    if (isWorkflow) {
      this._tagger.tagTextIO(span, prompts, outputs)
    } else {
      this._tagger.tagLLMIO(span, prompts, outputs)
    }
  }
}

module.exports = LangChainLLMObsLlmHandler
