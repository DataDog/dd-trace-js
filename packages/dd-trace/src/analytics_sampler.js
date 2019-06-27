'use strict'

const ANALYTICS = require('../../../ext/tags').ANALYTICS

let enabled = false

module.exports = {
  enable () {
    enabled = true
  },

  disable () {
    enabled = false
  },

  sample (span, rate, inherit) {
    if (rate !== undefined) {
      span.setTag(ANALYTICS, rate)
    } else if (inherit && enabled) {
      span.setTag(ANALYTICS, 1)
    }
  }
}
