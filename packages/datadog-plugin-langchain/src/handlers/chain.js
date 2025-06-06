'use strict'

const LangChainHandler = require('./default')

class LangChainChainHandler extends LangChainHandler {
  getSpanStartTags (ctx, provider, span) {
    const tags = {}

    if (!this.isPromptCompletionSampled(span)) return tags

    let inputs = ctx.args?.[0]
    inputs = Array.isArray(inputs) ? inputs : [inputs]

    for (let idx = 0; idx < inputs.length; idx++) {
      const input = inputs[idx]
      if (typeof input === 'object') {
        for (const [key, value] of Object.entries(input)) {
        // these are mappings to the python client names, ie lc_kwargs
        // only present on BaseMessage types
          if (key.includes('lc_')) continue
          tags[`langchain.request.inputs.${idx}.${key}`] = this.normalize(value)
        }
      } else {
        tags[`langchain.request.inputs.${idx}`] = this.normalize(input)
      }
    }

    return tags
  }

  getSpanEndTags (ctx, span) {
    const tags = {}

    if (!this.isPromptCompletionSampled(span)) return tags

    let outputs = ctx.result
    outputs = Array.isArray(outputs) ? outputs : [outputs]

    for (let idx = 0; idx < outputs.length; idx++) {
      const output = outputs[idx]
      tags[`langchain.response.outputs.${idx}`] = this.normalize(
        typeof output === 'string' ? output : JSON.stringify(output)
      )
    }

    return tags
  }
}

module.exports = LangChainChainHandler
