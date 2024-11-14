/* eslint-disable */
const sum = require('./dependency')

// TODO: instead of retrying through jest, this should be retried with auto test retries
jest.retryTimes(1)

describe('dynamic-instrumentation', () => {
  it('retries with DI', () => {
    expect(sum(11, 3)).toEqual(14)
  })

  it('is not retried', () => {
    expect(sum(1, 2)).toEqual(3)
  })
})
