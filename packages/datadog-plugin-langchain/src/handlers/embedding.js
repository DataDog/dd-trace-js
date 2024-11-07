'use strict'

const { truncate } = require('../util')
const LangChainHandler = require('./default')

class LangChainEmbeddingHandler extends LangChainHandler {
  getSpanStartTags (ctx) {
    const tags = {}

    const inputTexts = ctx.args?.[0]

    if (typeof inputTexts === 'string') {
      // embed query
      tags['langchain.request.inputs.0.text'] = truncate(inputTexts)
      tags['langchain.request.input_counts'] = 1
    } else {
      // embed documents
      for (const idx in inputTexts) {
        const inputText = inputTexts[idx]
        tags[`langchain.request.inputs.${idx}.text`] = truncate(inputText)
      }
      tags['langchain.request.input_counts'] = inputTexts.length
    }

    return tags
  }

  getSpanEndTags (ctx) {
    const tags = {}

    const { result } = ctx
    if (!Array.isArray(result)) return

    if (Array.isArray(result[0])) {
      for (const idx in result) {
        const output = result[idx]
        tags[`langchain.response.outputs.${idx}.embedding_length`] = output.length
      }
    } else {
      tags['langchain.response.outputs.embedding_length'] = result.length
    }

    return tags
  }

  extractApiKey (instance) {
    const apiKey = instance.clientConfig?.apiKey
    if (!apiKey || apiKey.length < 4) return
    return `...${apiKey.slice(-4)}`
  }

  extractProvider (instance) {
    return instance.constructor.name.split('Embeddings')[0].toLowerCase()
  }
}

module.exports = LangChainEmbeddingHandler
