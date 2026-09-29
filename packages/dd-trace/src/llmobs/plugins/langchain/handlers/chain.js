'use strict'

const { spanHasError } = require('../../../util')
const { formatIO } = require('../messages')
const LangChainLLMObsHandler = require('.')

class LangChainLLMObsChainHandler extends LangChainLLMObsHandler {
  setMetaTags ({ span, inputs, results }) {
    let input
    if (inputs) {
      input = formatIO(inputs)
    }

    const output = !results || spanHasError(span) ? '' : formatIO(results)

    // chain spans will always be workflows
    this._tagger.tagTextIO(span, input, output)
  }

  getName ({ span, instance, options }) {
    const firstCallable = /** @type {{ name?: string } | undefined} */ (instance?.first)

    if (firstCallable?.constructor?.name === 'ChannelWrite') return
    if (!this.isLangGraphNode(instance)) return super.getName({ span })

    // prebuilt nodes (e.g. ToolNode) wrap an anonymous callable, so prefer the node name LangGraph puts in the config
    return options?.metadata?.langgraph_node ?? firstCallable?.name
  }

  /**
   * LangGraph compiles each node into a `RunnableSequence` whose first step is the node's `RunnableCallable`.
   *
   * @param {Record<string, unknown> | undefined} instance
   * @returns {boolean}
   */
  isLangGraphNode (instance) {
    const first = /** @type {{ lc_namespace?: string[] } | undefined} */ (instance?.first)
    return first?.lc_namespace?.includes('langgraph') ?? false
  }
}

module.exports = LangChainLLMObsChainHandler
