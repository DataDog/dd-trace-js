'use strict'

const { AGENTLESS_EVALULATIONS_ENDPOINT } = require('../constants/writers')
const BaseWriter = require('./base')

class LLMObsEvalMetricsWriter extends BaseWriter {
  constructor (config) {
    super({
      config,
      intake: 'api',
      eventType: 'evaluation_metric',
      endpoint: AGENTLESS_EVALULATIONS_ENDPOINT
    })
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
