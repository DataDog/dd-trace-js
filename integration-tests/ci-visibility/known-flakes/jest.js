'use strict'

/* global test, jest */
// eslint-disable-next-line sonarjs/stable-tests
if (process.env.NATIVE_RETRIES) jest.retryTimes(Number(process.env.NATIVE_RETRIES))

let attempts = 0

test('known flaky failure', () => { throw new Error('known failure') })
test('new failure', () => { throw new Error('new failure') })
test('recovers', () => {
  if (++attempts < 2) throw new Error('intermittent failure')
})
