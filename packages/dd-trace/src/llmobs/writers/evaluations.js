'use strict'

const { AGENTLESS_EVALULATIONS_ENDPOINT } = require('../constants/writers')
const BaseWriter = require('./base')

class LLMObsEvalMetricsWriter extends BaseWriter {
  constructor (config) {
    super({
      endpoint: AGENTLESS_EVALULATIONS_ENDPOINT,
      intake: `api.${config.site}`,
      eventType: 'evaluation_metric'
    })

    this._headers['DD-API-KEY'] = config.apiKey
  }

  makePayload (events) {
    return {
      data: {
        type: this._eventType,
        attributes: {
          metrics: events
        }
      }
    }
  }
}

module.exports = LLMObsEvalMetricsWriter
