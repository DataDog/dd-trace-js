'use strict'

const LangChainLLMObsHandler = require('.')
const { spanHasError } = require('../../../util')

class LangChainLLMObsChainHandler extends LangChainLLMObsHandler {
  setMetaTags ({ span, inputs, results }) {
    let input, output
    if (inputs) {
      input = this.formatIO(inputs)
    }

    output = !results || spanHasError(span) ? '' : this.formatIO(results)

    // chain spans will always be workflows
    this._tagger.tagTextIO(span, input, output)
  }
}

module.exports = LangChainLLMObsChainHandler
