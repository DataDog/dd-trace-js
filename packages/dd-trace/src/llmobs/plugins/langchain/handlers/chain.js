'use strict'

const { spanHasError } = require('../../../util')
const LangChainLLMObsHandler = require('.')

class LangChainLLMObsChainHandler extends LangChainLLMObsHandler {
  setMetaTags ({ span, inputs, results }) {
    let input
    if (inputs) {
      input = this.formatIO(inputs)
    }

    const output = !results || spanHasError(span) ? '' : this.formatIO(results)

    // chain spans will always be workflows
    this._tagger.tagTextIO(span, input, output)
  }

  getName ({ span, instance }) {
    const firstCallable = instance?.first

    if (firstCallable?.constructor?.name === 'ChannelWrite') return

    const firstCallableIsLangGraph = firstCallable?.lc_namespace?.includes('langgraph')
    const firstCallableName = firstCallable?.name

    return firstCallableIsLangGraph ? firstCallableName : super.getName({ span })
  }
}

module.exports = LangChainLLMObsChainHandler
