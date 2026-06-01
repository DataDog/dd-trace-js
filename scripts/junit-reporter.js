'use strict'

const path = require('node:path')
const MochaJUnitReporter = require('mocha-junit-reporter')

const root = path.resolve(__dirname, '..')

/**
 * Thin wrapper around mocha-junit-reporter that rewrites absolute `file`
 * attributes to paths relative to the repository root.
 */
class JUnitReporter extends MochaJUnitReporter {
  getTestsuiteData (suite) {
    const testSuite = super.getTestsuiteData(suite)
    const attrs = testSuite.testsuite[0]._attr
    if (attrs.file) {
      attrs.file = path.relative(root, attrs.file)
    }
    return testSuite
  }
}

module.exports = JUnitReporter
