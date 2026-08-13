'use strict'

class ThrowingReporter {
  onEnd () {
    if (process.env.PLAYWRIGHT_REPORTER_THROWS_UNDEFINED) {
      // eslint-disable-next-line no-throw-literal
      throw undefined
    }
    throw new Error('custom Playwright reporter failed')
  }
}

module.exports = ThrowingReporter
