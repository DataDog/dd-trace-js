'use strict'

/* global jasmine */

const { appendFileSync } = require('node:fs')

let currentTestName
jasmine.getEnv().addReporter({
  specStarted (result) { currentTestName = result.fullName },
})

module.exports = function recordExecution () {
  if (process.env.WEBDRIVERIO_EXCLUSIONS_LEDGER) {
    appendFileSync(process.env.WEBDRIVERIO_EXCLUSIONS_LEDGER, `${currentTestName}\n`)
  }
}
