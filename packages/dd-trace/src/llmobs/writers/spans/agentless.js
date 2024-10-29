'use strict'

const { AGENTLESS_SPANS_ENDPOINT } = require('../../constants/writers')
const LLMObsBaseSpanWriter = require('./base')

class LLMObsAgentlessSpanWriter extends LLMObsBaseSpanWriter {
  constructor (config) {
    super({
      intake: `llmobs-intake.${config.site}`,
      endpoint: AGENTLESS_SPANS_ENDPOINT
    })

    this._headers['DD-API-KEY'] = config.apiKey
  }
}

module.exports = LLMObsAgentlessSpanWriter
