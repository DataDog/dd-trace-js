'use strict'

const LangChainHandler = require('./default')

class LangChainLanguageModelHandler extends LangChainHandler {
  extractProvider (instance) {
    return typeof instance._llmType === 'function' && instance._llmType().split('-')[0]
  }

  extractModel (instance) {
    for (const attr of ['model', 'modelName', 'modelId', 'modelKey', 'repoId']) {
      const modelName = instance[attr]
      if (modelName) return modelName
    }
  }
}

module.exports = LangChainLanguageModelHandler
