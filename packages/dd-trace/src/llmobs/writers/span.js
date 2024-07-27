const BaseWriter = require('./base')

class LLMObsSpanWriter extends BaseWriter {
  constructor (site, apiKey, interval, timeout) {
    super(site, apiKey, interval, timeout)
    this._eventType = 'span'
    this._endpoint = '/api/v2/llmobs'
    this._intake = `llmobs-intake.${this._site}`
  }

  makePayload (events) {
    return {
      '_dd.stage': 'raw',
      event_type: this._eventType,
      spans: events
    }
  }
}

module.exports = LLMObsSpanWriter
