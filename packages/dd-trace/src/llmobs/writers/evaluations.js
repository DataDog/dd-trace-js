'use strict'

const { EVALULATIONS_ENDPOINT } = require('../constants/writers')
const LLMObsWriter = require('./base')

class LLMObsEvalMetricsWriter extends LLMObsWriter {
  constructor (tracerConfig) {
    super({
      endpoint: EVALULATIONS_ENDPOINT,
      agentlessIntake: `api.${tracerConfig.site}`,
      eventType: 'evaluation_metric',
      tracerConfig
    }, true)
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
