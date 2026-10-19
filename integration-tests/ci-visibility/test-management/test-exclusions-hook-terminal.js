'use strict'

const { noAutoRetry } = require('dd-trace/test-optimization')

// eslint-disable-next-line sonarjs/stable-tests -- verifies terminal failure with configured native retries
jest.retryTimes(2)
beforeAll(() => { throw new Error('setup failed before the test could run') })
test('setup failure is terminal', noAutoRetry(() => {}))
