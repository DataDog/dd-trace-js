'use strict'

class ThrowingReporter {
  onRunComplete () {
    throw new Error('custom reporter failed')
  }
}

module.exports = ThrowingReporter
