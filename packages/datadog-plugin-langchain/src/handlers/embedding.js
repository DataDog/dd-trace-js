'use strict'

const LangChainHandler = require('./default')

class LangChainEmbeddingHandler extends LangChainHandler {
  getSpanStartTags (ctx) {
    const tags = {}

    const inputTexts = ctx.args?.[0]

    const sampled = this.isPromptCompletionSampled()
    if (typeof inputTexts === 'string') {
      // embed query
      if (sampled) {
        tags['langchain.request.inputs.0.text'] = this.normalize(inputTexts)
      }
      tags['langchain.request.input_counts'] = 1
    } else {
      // embed documents
      if (sampled) {
        for (const idx in inputTexts) {
          const inputText = inputTexts[idx]
          tags[`langchain.request.inputs.${idx}.text`] = this.normalize(inputText)
        }
      }
      tags['langchain.request.input_counts'] = inputTexts.length
    }

    return tags
  }

  getSpanEndTags (ctx) {
    const tags = {}

    const { result } = ctx
    if (!Array.isArray(result)) return

    tags['langchain.response.outputs.embedding_length'] = (
      Array.isArray(result[0]) ? result[0] : result
    ).length

    return tags
  }

  extractApiKey (instance) {
    const apiKey = instance.clientConfig?.apiKey
    if (!apiKey || apiKey.length < 4) return ''
    return `...${apiKey.slice(-4)}`
  }

  extractProvider (instance) {
    return instance.constructor.name.split('Embeddings')[0].toLowerCase()
  }

  extractModel (instance) {
    for (const attr of ['model', 'modelName', 'modelId', 'modelKey', 'repoId']) {
      const modelName = instance[attr]
      if (modelName) return modelName
    }
  }
}

module.exports = LangChainEmbeddingHandler
