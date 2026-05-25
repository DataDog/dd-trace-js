'use strict'

const config = {
  projects: process.env.PROJECTS ? JSON.parse(process.env.PROJECTS) : [__dirname],
  testPathIgnorePatterns: ['/node_modules/'],
  cache: false,
  testMatch: [
    process.env.CONFIG_TEST_MATCH || process.env.TESTS_TO_RUN || '**/ci-visibility/test/ci-visibility-test*',
  ],
  testRunner: 'jest-circus/runner',
  testEnvironment: 'node',
}

if (process.env.COLLECT_COVERAGE_FROM) {
  config.collectCoverageFrom = process.env.COLLECT_COVERAGE_FROM.split(',')
}

if (process.env.ENABLE_CODE_COVERAGE || process.env.CONFIG_COLLECT_COVERAGE) {
  config.collectCoverage = true
}

if (process.env.COVERAGE_REPORTERS) {
  config.coverageReporters = process.env.COVERAGE_REPORTERS.split(',')
}

module.exports = config
