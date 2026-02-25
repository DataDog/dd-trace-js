'use strict'

module.exports = {
  projects: [],
  testPathIgnorePatterns: ['/node_modules/'],
  cache: false,
  testMatch: [
    '**/ci-visibility/automatic-log-submission/automatic-log-submission-*',
  ],
  testRunner: 'jest-circus/runner',
  testEnvironment: 'node',
}
