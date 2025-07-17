'use strict'

const LangChainHandler = require('./default')

class LangChainEmbeddingHandler extends LangChainHandler {
  getSpanStartTags (ctx, provider, span) {
    return {}
  }

  getSpanEndTags (ctx) {
    return {}
  }

  extractApiKey (instance) {
    const apiKey =
      instance.clientConfig?.apiKey ||
      instance.apiKey ||
      instance.client?.apiKey
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
