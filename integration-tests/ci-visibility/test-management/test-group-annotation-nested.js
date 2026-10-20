'use strict'

const { noAutoRetry, preventFailureSuppression } = require('dd-trace/test-optimization')

let outerAttempt = 0
describe('outer', () => {
  // eslint-disable-next-line sonarjs/stable-tests -- verify nested native describe retry budgets
  jest.retryTimes(1, { entireDescribe: true })
  beforeAll(() => { outerAttempt++ })
  describe('inner', () => {
    // eslint-disable-next-line sonarjs/stable-tests -- the inner budget resets when the outer block retries
    jest.retryTimes(1, { entireDescribe: true })
    function nativeRetryCallback () {
      let attempts = 0
      return () => {
        if (++attempts !== 2 || outerAttempt > 1) throw new Error('terminal nested failure')
      }
    }
    test('bare', noAutoRetry(nativeRetryCallback()))
    test('combined', preventFailureSuppression(noAutoRetry(nativeRetryCallback())))
    test('ordinary sibling', () => {})
  })
  test('outer gate', noAutoRetry(() => {
    if (outerAttempt === 1) throw new Error('rerun outer block')
  }))
})
test('outside excluded', noAutoRetry(() => { throw new Error('outside native retry blocks') }))
