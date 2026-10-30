'use strict'

module.exports = [
  ['>=24.8.0 <30.0.0', 'build/runTest.js'],
  ['>=30.0.0', 'build/index.js'],
  ['>=30.0.0', 'build/testWorker.js'],
].map(([versionRange, filePath]) => ({
  module: { name: 'jest-runner', versionRange, filePath },
  // Wrap the returned promise so completion covers both successful and failed teardown.
  functionQuery: { functionName: 'runTestInternal', kind: 'Sync' },
  channelName: 'runTestInternal',
}))
