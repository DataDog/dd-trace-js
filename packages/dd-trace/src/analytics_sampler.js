'use strict'

const { MEASURED } = require('../../../ext/tags')

module.exports = {
  sample (span, measured, measuredByDefault) {
    if (typeof measured === 'object') {
      this.sample(span, measured[span.context()._name], measuredByDefault)
    } else if (measured || measured !== undefined) {
      span.setTag(MEASURED, !!measured)
    }
  }
}
