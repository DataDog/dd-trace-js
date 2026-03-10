'use strict'

const reporterEnabled = ['spec']

// eslint-disable-next-line eslint-rules/eslint-process-env
if (process.env.CI) {
  reporterEnabled.push('./scripts/junit-reporter.js')
}

module.exports = {
  reporterEnabled,
  scriptsJunitReporterJsReporterOptions: {
    mochaFile: `./node-${process.versions.node}-junit.xml`,
  },
}
