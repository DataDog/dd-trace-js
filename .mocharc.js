'use strict'

module.exports = {
  color: true,
  exit: true,
  timeout: 5000,
  reporter: 'xunit',
  reporterOptions: {
    output: `./node-${process.versions.node}-junit.xml`,
    showRelativePaths: true
  },
}
