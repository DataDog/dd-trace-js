'use strict'

const { getSegment } = require('../../../dd-trace/src/util')
const LangChainHandler = require('./default')

class LangChainEmbeddingHandler extends LangChainHandler {
  extractProvider (instance) {
    return getSegment(instance.constructor.name, 'Embeddings', 0).toLowerCase()
  }

  extractModel (instance) {
    for (const attr of ['model', 'modelName', 'modelId', 'modelKey', 'repoId']) {
      const modelName = instance[attr]
      if (modelName) return modelName
    }
  }
}

module.exports = LangChainEmbeddingHandler
