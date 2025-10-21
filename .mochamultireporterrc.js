'use strict'

const reporterEnabled = ['spec']

// eslint-disable-next-line eslint-rules/eslint-process-env
if (process.env.CI) {
  reporterEnabled.push('mocha-junit-reporter')
}

module.exports = {
  reporterEnabled,
  mochaJunitReporterReporterOptions: {
    mochaFile: `./node-${process.versions.node}-junit.xml`
  }
}
