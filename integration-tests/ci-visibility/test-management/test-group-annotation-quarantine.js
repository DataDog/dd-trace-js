'use strict'

const { noAutoRetry, preventFailureSuppression } = require('dd-trace/test-optimization')

const fail = noAutoRetry(() => { throw new Error('native quarantined failure') })
describe('native group', () => {
  // eslint-disable-next-line sonarjs/stable-tests -- preserve quarantine when native describe retry policy is present
  jest.retryTimes(1, { entireDescribe: true })
  test('quarantined', process.env.EXCLUSIONS_PROTECT_QUARANTINE === '1' ? preventFailureSuppression(fail) : fail)
})
