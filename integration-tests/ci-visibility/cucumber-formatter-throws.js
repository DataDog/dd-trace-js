'use strict'

const { Formatter } = require('@cucumber/cucumber')

class ThrowingFormatter extends Formatter {
  constructor (options) {
    super(options)
    options.eventBroadcaster.on('envelope', (envelope) => {
      if (envelope.testRunFinished) {
        throw new Error('custom Cucumber formatter failed')
      }
    })
  }
}

module.exports = ThrowingFormatter
