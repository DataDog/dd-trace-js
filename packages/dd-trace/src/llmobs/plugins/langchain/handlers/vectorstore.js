'use strict'

const LangChainLLMObsHandler = require('.')
const { spanHasError } = require('../../../util')

class LangChainLLMObsVectorStoreHandler extends LangChainLLMObsHandler {
  setMetaTags ({ span, inputs, results }) {
    const input = this.formatIO(inputs)
    if (spanHasError(span)) {
      this._tagger.tagRetrievalIO(span, input)
      return
    }

    const documents = []
    for (const documentResult of results) {
      let document, score
      if (Array.isArray(documentResult)) {
        document = documentResult[0]
        score = documentResult[1]
      } else {
        document = documentResult
      }

      documents.push({
        text: document.pageContent,
        id: document.id,
        name: document.metadata?.source,
        score
      })
    }

    this._tagger.tagRetrievalIO(span, input, documents)
  }
}

module.exports = LangChainLLMObsVectorStoreHandler
