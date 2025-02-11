'use strict'

const LangChainLLMObsHandler = require('.')
const LLMObsTagger = require('../../../tagger')
const { spanHasError } = require('../../../util')

class LangChainLLMObsLlmHandler extends LangChainLLMObsHandler {
  setMetaTags ({ span, inputs, results }) {
    const isWorkflow = LLMObsTagger.getSpanKind(span) === 'workflow'
    const prompts = Array.isArray(inputs) ? inputs : [inputs]

    let outputs
    if (spanHasError(span)) {
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
