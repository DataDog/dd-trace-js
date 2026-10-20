'use strict'

const { noAutoRetry, preventFailureSuppression } = require('dd-trace/test-optimization')
const mode = process.env.EXCLUSIONS_DESCRIBE_MODE || 'exhaust'
// eslint-disable-next-line sonarjs/stable-tests -- verify zero group retries override explicit global test retries
if (mode === 'zero-with-global') jest.retryTimes(1)

describe('native group', () => {
  // eslint-disable-next-line sonarjs/stable-tests -- exercise native describe retry policy independently of ATR
  jest.retryTimes(mode.startsWith('zero') ? 0 : 1, { entireDescribe: true })
  let bareAttempts = 0
  let combinedAttempts = 0
  test('bare', noAutoRetry(() => {
    if (++bareAttempts === 1 || mode !== 'recover') throw new Error('native describe retry')
  }))
  test('combined', preventFailureSuppression(noAutoRetry(() => {
    if (++combinedAttempts === 1 || mode !== 'recover') throw new Error('native describe retry')
  })))
  test('ordinary sibling', () => {})
})
test('outside excluded', noAutoRetry(() => { throw new Error('no native retries outside describe') }))
