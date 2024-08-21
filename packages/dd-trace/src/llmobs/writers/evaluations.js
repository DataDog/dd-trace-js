const BaseWriter = require('./base')

class LLMObsEvalMetricsWriter extends BaseWriter {
  constructor (config) {
    super({
      config,
      endpoint: '/api/intake/llm-obs/v1/eval-metric',
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
