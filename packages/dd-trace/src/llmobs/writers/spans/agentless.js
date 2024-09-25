'use strict'

const { AGENTLESS_SPANS_ENDPOINT } = require('../../constants')
const LLMObsBaseSpanWriter = require('./base')

class LLMObsAgentlessSpanWriter extends LLMObsBaseSpanWriter {
  constructor (config) {
    super({
      intake: `llmobs-intake.${config.site}`,
      endpoint: AGENTLESS_SPANS_ENDPOINT
    })

    this._headers['DD-API-KEY'] = config.llmobs?.apiKey || config.apiKey
  }
}

module.exports = LLMObsAgentlessSpanWriter
