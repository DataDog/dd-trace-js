'use strict'

const LangChainLLMObsHandler = require('.')
const LLMObsTagger = require('../../../tagger')
const { spanHasError } = require('../../../util')

class LangChainLLMObsEmbeddingHandler extends LangChainLLMObsHandler {
  setMetaTags ({ span, inputs, results }) {
    const isWorkflow = LLMObsTagger.getSpanKind(span) === 'workflow'
    let embeddingInput, embeddingOutput

    if (isWorkflow) {
      embeddingInput = this.formatIO(inputs)
    } else {
      const input = Array.isArray(inputs) ? inputs : [inputs]
      embeddingInput = input.map(doc => ({ text: doc }))
    }

    if (spanHasError(span) || !results) {
      embeddingOutput = ''
    } else {
      let embeddingDimensions, embeddingsCount
      if (typeof results[0] === 'number') {
        embeddingsCount = 1
        embeddingDimensions = results.length
      } else {
        embeddingsCount = results.length
        embeddingDimensions = results[0].length
      }

      embeddingOutput = `[${embeddingsCount} embedding(s) returned with size ${embeddingDimensions}]`
    }

    if (isWorkflow) {
      this._tagger.tagTextIO(span, embeddingInput, embeddingOutput)
    } else {
      this._tagger.tagEmbeddingIO(span, embeddingInput, embeddingOutput)
    }
  }
}

module.exports = LangChainLLMObsEmbeddingHandler
