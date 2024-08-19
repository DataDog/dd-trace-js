const BaseWriter = require('../base')

class LLMObsSpanWriter extends BaseWriter {
  constructor (options) {
    super({
      ...options,
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
