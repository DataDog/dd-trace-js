'use strict'

const { noAutoRetry } = require('dd-trace/test-optimization')

const fail = noAutoRetry(() => { throw new Error('intentional failure') })
describe('native group', () => {
  // eslint-disable-next-line sonarjs/stable-tests -- verify native describe retries independently of automatic retries
  jest.retryTimes(1, { entireDescribe: true })
  test('native retry', fail)
})
test('excluded sibling', fail)
