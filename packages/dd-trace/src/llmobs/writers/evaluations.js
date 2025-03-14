'use strict'

const { AGENTLESS_EVALULATIONS_ENDPOINT } = require('../constants/writers')
const BaseLLMObsWriter = require('./base')

class LLMObsEvalMetricsWriter extends BaseLLMObsWriter {
  constructor (config) {
    super({
      endpoint: AGENTLESS_EVALULATIONS_ENDPOINT,
      intake: `api.${config.site}`,
      eventType: 'evaluation_metric'
    })

    this._headers['DD-API-KEY'] = config.apiKey
  }

  /**
   * Formats the evaluation metrics payload
   * @override
   * @param {*} events - list of LLM Observability evaluation metrics
   * @returns {Record<string, string | unknown[]>} the formatted payload
   */
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
