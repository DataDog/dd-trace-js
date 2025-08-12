'use strict'

const {
  EVALUATIONS_ENDPOINT,
  EVALUATIONS_EVENT_TYPE,
  EVALUATIONS_INTAKE
} = require('../constants/writers')
const BaseWriter = require('./base')

class LLMObsEvalMetricsWriter extends BaseWriter {
  constructor (config) {
    super({
      config,
      intake: EVALUATIONS_INTAKE,
      eventType: EVALUATIONS_EVENT_TYPE,
      endpoint: EVALUATIONS_ENDPOINT
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
