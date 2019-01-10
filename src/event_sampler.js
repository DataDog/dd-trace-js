'use strict'

const EVENT_SAMPLE_RATE = require('../ext/tags').EVENT_SAMPLE_RATE

module.exports = {
  sample (span, rates) {
    switch (typeof rates) {
      case 'number':
        if (rates < 0 || rates > 1) return

        span.setTag(EVENT_SAMPLE_RATE, rates)

        break
      case 'object': {
        const name = span.context()._name

        if (rates.hasOwnProperty(name)) {
          this.sample(span, rates[name])
        }

        break
      }
    }
  }
}
