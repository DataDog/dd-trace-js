'use strict'

const { noAutoRetry } = require('dd-trace/test-optimization')

// Deliberately matches the Datadog retry count: detect the call, not a changed value.
// eslint-disable-next-line sonarjs/stable-tests -- verifies explicit developer retry configuration
jest.retryTimes(2)
let executions = 0
test('explicit retries', noAutoRetry(() => {
  if (++executions < 3) throw new Error('retry me')
}))
