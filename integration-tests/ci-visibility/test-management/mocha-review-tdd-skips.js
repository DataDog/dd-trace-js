'use strict'

const { preventFailureSuppression, noAutoRetry } = require('dd-trace/test-optimization')

suite('TDD skips', () => {
  const fail = () => { throw new Error('must remain skipped') }
  test.skip('combined', preventFailureSuppression(noAutoRetry(fail)))
  test.skip('protected', preventFailureSuppression(fail))
  test.skip('no retry', noAutoRetry(fail))
  test.skip('ordinary skip', fail)
  test('pending control')
  test('live control', () => {})
})
