'use strict'

const LangChainLLMObsHandler = require('.')
const { spanHasError } = require('../../../util')

class LangChainLLMObsToolHandler extends LangChainLLMObsHandler {
  getName ({ instance }) {
    return instance.name
  }

  setMetaTags ({ span, inputs, results }) {
    const input = inputs && this.formatIO(inputs)
    const output = (results && !spanHasError(span)) && this.formatIO(results)

    this._tagger.tagTextIO(span, input, output)
  }
}

module.exports = LangChainLLMObsToolHandler
