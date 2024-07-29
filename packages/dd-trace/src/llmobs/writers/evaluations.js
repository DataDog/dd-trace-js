const BaseWriter = require('./base')

class LLMObsEvalMetricsWriter extends BaseWriter {
  constructor ({ site, apiKey, interval, timeout }) {
    super({
      site,
      apiKey,
      interval,
      timeout,
      endpoint: '/api/unstable/llm-obs/v1/eval-metric',
      intake: `api.${site}`,
      eventType: 'evaluation_metric'
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
