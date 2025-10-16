'use strict'

module.exports = {
  reporterEnabled: ["spec", "mocha-junit-reporter"],
  mochaJunitReporterReporterOptions: {
    mochaFile: `./node-${process.versions.node}-junit.xml`
  }
}
