'use strict'

const LLMObsTagger = require('../tagger')

class BaseLLMObsIntegration {
  constructor (config) {
    this._config = config
    this._tagger = new LLMObsTagger(config)
  }
}

module.exports = BaseLLMObsIntegration
