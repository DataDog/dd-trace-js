'use strict'

const { AsyncResource } = require('node:async_hooks')

const { noAutoRetry, preventFailureSuppression } = require('dd-trace/test-optimization')
const mode = process.env.EXCLUSIONS_TERMINAL_MODE
const externalErrorContext = new AsyncResource('external-native-describe-error')
if (mode === 'external-expect') expect.assertions(1)

describe('native terminal', () => {
  // eslint-disable-next-line sonarjs/stable-tests -- exercise explicit native describe retries
  jest.retryTimes(2, { entireDescribe: true })
  test('bare', noAutoRetry(async () => {
    if (mode === 'uncaught-body' || mode === 'owned-body') {
      const scheduleError = () => setTimeout(() => { throw new Error('uncaught native describe failure') }, 0)
      if (mode === 'uncaught-body') {
        // External background work has no Circus test owner, even when its error fires during this test.
        externalErrorContext.runInAsyncScope(scheduleError)
      } else {
        scheduleError()
      }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('excluded terminal failure')
  }))
  test('combined', preventFailureSuppression(noAutoRetry(() => {
    throw new Error('protected terminal failure')
  })))
  afterAll(async () => {
    externalErrorContext.emitDestroy()
    if (mode === 'uncaught-after-all') {
      setTimeout(() => { throw new Error('late uncaught native describe failure') }, 0)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  })
})
test('later marker', () => {})
