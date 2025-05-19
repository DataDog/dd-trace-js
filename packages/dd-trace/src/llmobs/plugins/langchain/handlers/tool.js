'use strict'

const LangChainLLMObsHandler = require('.')
const { spanHasError } = require('../../../util')

class LangChainLLMObsToolHandler extends LangChainLLMObsHandler {
  getName ({ instance }) {
    return instance.name
  }

  setMetaTags ({ span, inputs, results }) {
    let input, output
    if (inputs) {
      input = this.formatIO(inputs)
    }

    if (!results || spanHasError(span)) {
      output = ''
    } else {
      output = this.formatIO(results)
    }

    // chain spans will always be workflows
    this._tagger.tagTextIO(span, input, output)
  }
}

module.exports = LangChainLLMObsToolHandler
