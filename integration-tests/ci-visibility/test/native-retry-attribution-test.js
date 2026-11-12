'use strict'

if (process.env.NATIVE_RETRY_COUNT) {
  // eslint-disable-next-line sonarjs/stable-tests -- Deliberately exercise native retry attribution.
  jest.retryTimes(Number(process.env.NATIVE_RETRY_COUNT))
}

let attempts = 0
test('native retry budget', () => {
  if (process.env.NATIVE_RETRY_PASSES === '1' && ++attempts > Number(process.env.NATIVE_RETRY_COUNT)) return
  throw new Error('expected failure')
})
