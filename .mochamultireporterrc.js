'use strict'

/* eslint-disable eslint-rules/eslint-process-env */

const { getJunitFile } = require('./scripts/junit-file')

const reporterEnabled = ['spec']

if (process.env.CI) {
  reporterEnabled.push('./scripts/junit-reporter.js')
}

module.exports = {
  reporterEnabled,
  scriptsJunitReporterJsReporterOptions: {
    mochaFile: getJunitFile(process.env.npm_lifecycle_event || 'mocha'),
  },
}
