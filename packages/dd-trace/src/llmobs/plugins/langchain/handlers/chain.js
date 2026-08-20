'use strict'

const { formatIO } = require('../messages')
const LangChainLLMObsHandler = require('.')

class LangChainLLMObsChainHandler extends LangChainLLMObsHandler {
  setMetaTags ({ span, inputs, results, error }) {
    let input
    if (inputs) {
      input = formatIO(inputs)
    }

    const output = !results || error ? '' : formatIO(results)

    // chain spans will always be workflows
    this._tagger.tagTextIO(span, input, output)
  }

  getName ({ instance, resource }) {
    const firstCallable = instance?.first

    if (firstCallable?.constructor?.name === 'ChannelWrite') return

    const firstCallableIsLangGraph = firstCallable?.lc_namespace?.includes('langgraph')
    const firstCallableName = firstCallable?.name

    return firstCallableIsLangGraph ? firstCallableName : super.getName({ resource })
  }
}

module.exports = LangChainLLMObsChainHandler
