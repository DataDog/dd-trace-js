'use strict'

module.exports = {
  projects: [],
  testPathIgnorePatterns: ['/node_modules/'],
  cache: false,
  testMatch: [
    process.env.TEST_MODULE_TYPE === 'esm'
      ? '**/ci-visibility/automatic-log-submission/automatic-log-submission-esm-test.mjs'
      : '**/ci-visibility/automatic-log-submission/automatic-log-submission-test.js',
  ],
  testRunner: 'jest-circus/runner',
  testEnvironment: 'node',
}
