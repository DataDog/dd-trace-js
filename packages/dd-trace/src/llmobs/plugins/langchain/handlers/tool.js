'use strict'

const { spanHasError } = require('../../../util')
const { formatIO } = require('../messages')
const LangChainLLMObsHandler = require('.')

// RunnableConfig keys that are plain data; the rest (callbacks, LangGraph `configurable` internals) are not
// JSON-serializable.
const TOOL_CONFIG_KEYS = ['tags', 'metadata', 'runName', 'recursionLimit']

class LangChainLLMObsToolHandler extends LangChainLLMObsHandler {
  getName ({ instance }) {
    return typeof instance?.name === 'string' ? instance.name : undefined
  }

  setMetaTags ({ span, inputs, results, options, instance }) {
    /**
     * @type {{ tool_config?: Record<string, unknown>, tool_info?: { name: string, description?: string } } | undefined}
     */
    let metadata

    if (options && typeof options === 'object') {
      /** @type {Record<string, unknown> | undefined} */
      let toolConfig
      for (const key of TOOL_CONFIG_KEYS) {
        if (options[key] === undefined) continue
        toolConfig ??= {}
        toolConfig[key] = options[key]
      }
      if (toolConfig) metadata = { tool_config: toolConfig }
    }

    if (instance?.name) {
      metadata ??= {}
      metadata.tool_info = { name: instance.name, description: instance.description }
    }

    if (metadata) this._tagger.tagMetadata(span, metadata)

    const input = inputs == null ? '' : formatIO(inputs)
    const output = spanHasError(span) || results == null ? '' : formatIO(results)
    this._tagger.tagTextIO(span, input, output)
  }
}

module.exports = LangChainLLMObsToolHandler
