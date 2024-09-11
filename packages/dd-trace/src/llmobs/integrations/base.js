'use strict'

const LLMObsTagger = require('../tagger')

class BaseLLMObsIntegration {
  constructor (config) {
    this._config = config
    this._tagger = new LLMObsTagger(config)
  }

  setSpanStartTags () {
    throw new Error('setSpanStartTags must be implemented by the LLMObs subclass')
  }

  setSpanEndTags () {
    throw new Error('setSpanEndTags must be implemented by the LLMObs subclass')
  }
}

module.exports = BaseLLMObsIntegration
