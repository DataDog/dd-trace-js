'use strict'

const makeUtilities = require('../../../dd-trace/src/plugins/util/llm')

class LangChainHandler {
  constructor (tracerConfig) {
    const utilities = makeUtilities('langchain', tracerConfig)

    this.normalize = utilities.normalize
    this.isPromptCompletionSampled = utilities.isPromptCompletionSampled
  }

  // no-op for default handler
  getSpanStartTags (ctx) {}

  // no-op for default handler
  getSpanEndTags (ctx) {}

  // no-op for default handler
  extractApiKey (instance) {}

  // no-op for default handler
  extractProvider (instance) {}

  // no-op for default handler
  extractModel (instance) {}
}

module.exports = LangChainHandler
