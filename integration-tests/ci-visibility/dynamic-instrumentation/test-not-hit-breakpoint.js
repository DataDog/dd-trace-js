/* eslint-disable */
const sum = require('./dependency')

// TODO: instead of retrying through jest, this should be retried with auto test retries
jest.retryTimes(1)

let count = 0
describe('dynamic-instrumentation', () => {
  it('retries with DI', () => {
    const willFail = count++ === 0
    if (willFail) {
      expect(sum(11, 3)).toEqual(14) // only throws the first time
    } else {
      expect(sum(1, 2)).toEqual(3)
    }
  })
})
