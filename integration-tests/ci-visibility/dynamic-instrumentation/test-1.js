const sum = require('./dependency')

// TODO: instead of retrying through jest, this should be retried with auto test retries
// eslint-disable-next-line
jest.retryTimes(1)

describe('dynamic-instrumentation', () => {
  it('retries with DI', () => {
    // eslint-disable-next-line
    expect(sum(11, 3)).toEqual(14)
  })
})
