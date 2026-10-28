'use strict'

function fail () {
  throw new Error('expected failure')
}

test('root ATR', fail)

describe('native describe', () => {
  // eslint-disable-next-line sonarjs/stable-tests -- Deliberately exercise native retry attribution.
  jest.retryTimes(Number(process.env.NATIVE_RETRY_COUNT), { entireDescribe: true })
  test('fails', fail)
  test('passes', () => {})
  describe('nested', () => {
    test('fails', fail)
  })
})

describe('sibling ATR', () => {
  test('fails', fail)
})
