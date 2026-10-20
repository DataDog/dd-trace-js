'use strict'

const { noAutoRetry, preventFailureSuppression } = require('dd-trace/test-optimization')
const replay = process.env.EXCLUSIONS_PASSING_REPLAY === '1'

describe('native passing', () => {
  // eslint-disable-next-line sonarjs/stable-tests -- exercise native group replay caused by a sibling failure
  jest.retryTimes(1, { entireDescribe: true })
  test('bare', noAutoRetry(() => {}))
  test('combined', preventFailureSuppression(noAutoRetry(() => {})))
  test('quarantined', noAutoRetry(() => {}))
  let attempts = 0
  test('ordinary sibling', () => {
    if (replay && ++attempts === 1) throw new Error('replay the entire describe')
  })
})
test('later marker', () => {})
