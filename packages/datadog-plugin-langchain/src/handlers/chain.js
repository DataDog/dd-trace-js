'use strict'

const LangChainHandler = require('./default')

class LangChainChainHandler extends LangChainHandler {
  getSpanStartTags (ctx, provider, span) {
    return {}
  }

  getSpanEndTags (ctx, span) {
    return {}
  }
}

module.exports = LangChainChainHandler
