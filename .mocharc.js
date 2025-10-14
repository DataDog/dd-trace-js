'use strict'

module.exports = {
  color: true,
  exit: true,
  timeout: 5000,
  reporter: 'mocha-multi-reporters',
  reporterOptions: {
    reporterEnabled: 'spec, mocha-junit-reporter',
    mochaJunitReporterReporterOptions: {
      mochaFile: `./node-${process.versions.node}-junit.xml`
    }
  },
}
