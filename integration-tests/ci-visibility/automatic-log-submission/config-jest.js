'use strict'

const isWorkerShutdownTest = process.env.TEST_JEST_WORKER_SHUTDOWN === '1'

module.exports = {
  projects: [],
  testPathIgnorePatterns: ['/node_modules/'],
  cache: false,
  testMatch: [
    '**/ci-visibility/automatic-log-submission/automatic-log-submission-test.js',
    ...(isWorkerShutdownTest
      ? ['**/ci-visibility/automatic-log-submission/automatic-log-submission-spacer-test.js']
      : []),
  ],
  testRunner: 'jest-circus/runner',
  testEnvironment: 'node',
  ...(isWorkerShutdownTest && { maxWorkers: 2 }),
}
