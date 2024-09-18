'use strict'

const LLMObsBaseSpanWriter = require('./base')

class LLMObsAgentlessSpanWriter extends LLMObsBaseSpanWriter {
  constructor (config) {
    super({
      intake: `llmobs-intake.${config.site}`,
      endpoint: '/api/v2/llmobs'
    })

    this._headers['DD-API-KEY'] = config.llmobs?.apiKey || config.apiKey
  }
}

module.exports = LLMObsAgentlessSpanWriter
