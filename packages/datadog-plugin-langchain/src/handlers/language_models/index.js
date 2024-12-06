'use strict'

const { getTokensFromLlmOutput } = require('../../tokens')
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

  extractTokenMetrics (span, result) {
    if (!span || !result) return

    // we do not tag token metrics for non-openai providers
    const provider = span.context()._tags['langchain.request.provider']
    if (provider !== 'openai') return

    const tokens = getTokensFromLlmOutput(result)

    for (const [tokenKey, tokenCount] of Object.entries(tokens)) {
      span.setTag(`langchain.tokens.${tokenKey}_tokens`, tokenCount)
    }
  }
}

module.exports = LangChainLanguageModelHandler
