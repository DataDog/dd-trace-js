'use strict'

const reporterEnabled = ['spec']

if (process.env.CI) {
  reporterEnabled.push('mocha-junit-reporter')
}

module.exports = {
  reporterEnabled,
  mochaJunitReporterReporterOptions: {
    mochaFile: `./node-${process.versions.node}-junit.xml`
  }
}
