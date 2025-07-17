'use strict'

const LangChainHandler = require('../default')

class LangChainLanguageModelHandler extends LangChainHandler {
  extractApiKey (instance) {
    const key = Object.keys(instance)
      .find(key => {
        const lower = key.toLowerCase()
        return lower.includes('apikey') || lower.includes('apitoken')
      })

    let apiKey = instance[key]
    if (apiKey?.secretValue && typeof apiKey.secretValue === 'function') {
      apiKey = apiKey.secretValue()
    }
    if (!apiKey || apiKey.length < 4) return ''
    return `...${apiKey.slice(-4)}`
  }

  extractProvider (instance) {
    return typeof instance._llmType === 'function' && instance._llmType().split('-')[0]
  }

  extractModel (instance) {
    for (const attr of ['model', 'modelName', 'modelId', 'modelKey', 'repoId']) {
      const modelName = instance[attr]
      if (modelName) return modelName
    }
  }

  getSpanStartTags (ctx, provider, span) {
    return {}
  }

  getSpanEndTags (ctx, span) {
    return {}
  }
}

module.exports = LangChainLanguageModelHandler
