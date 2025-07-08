'use strict'

const LangChainLLMObsHandler = require('.')

class LangChainLLMObsToolHandler extends LangChainLLMObsHandler {
  getName ({ instance }) {
    return instance.name
  }

  setMetaTags ({ span, inputs, results }) {
    this._tagger.tagTextIO(span, inputs, results)
  }
}

module.exports = LangChainLLMObsToolHandler
