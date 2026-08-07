'use strict'

class ThrowingReporter {
  onEnd () {
    throw new Error('custom Playwright reporter failed')
  }
}

module.exports = ThrowingReporter
