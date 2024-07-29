const BaseWriter = require('./base')

class LLMObsSpanWriter extends BaseWriter {
  constructor ({ site, apiKey, interval, timeout }) {
    super({
      site,
      apiKey,
      interval,
      timeout,
      endpoint: '/api/v2/llmobs',
      intake: `llmobs-intake.${site}`,
      eventType: 'span'
    })
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
