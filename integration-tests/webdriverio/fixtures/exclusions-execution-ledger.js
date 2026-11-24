'use strict'

/* global jasmine */

const { appendFileSync } = require('node:fs')

let currentTestName
if (process.env.WEBDRIVERIO_FRAMEWORK === 'jasmine') {
  jasmine.getEnv().addReporter({
    specStarted (result) { currentTestName = result.fullName },
  })
} else {
  beforeEach(function () { currentTestName = this.currentTest.fullTitle() })
}

module.exports = function recordExecution () {
  if (process.env.WEBDRIVERIO_EXCLUSIONS_LEDGER) {
    appendFileSync(process.env.WEBDRIVERIO_EXCLUSIONS_LEDGER, `${currentTestName}\n`)
  }
}
