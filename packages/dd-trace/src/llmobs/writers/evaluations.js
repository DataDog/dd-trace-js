const BaseWriter = require('./base')

class LLMObsEvalMetricsWriter extends BaseWriter {
  constructor (site, apiKey, interval, timeout) {
    super(site, apiKey, interval, timeout)
    this._eventType = 'evaluation_metric'
    this._endpoint = '/api/unstable/llm-obs/v1/eval-metric'
    this._intake = `api.${this._site}`
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
