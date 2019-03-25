'use strict'

const ANALYTICS = require('../ext/tags').ANALYTICS

module.exports = {
  sample (span, config, useDefault) {
    if (!config || config.enabled !== true) return

    if (useDefault) {
      if (config.sampleRate === undefined) {
        span.setTag(ANALYTICS, 1)
      } else if (config.sampleRate >= 0 && config.sampleRate <= 1) {
        span.setTag(ANALYTICS, config.sampleRate)
      }
    }

    if (config.sampleRates && typeof config.sampleRates === 'object') {
      const name = span.context()._name

      if (config.sampleRates.hasOwnProperty(name)) {
        this.sample(span, {
          enabled: true,
          sampleRate: config.sampleRates[name]
        }, true)
      }
    }
  }
}
