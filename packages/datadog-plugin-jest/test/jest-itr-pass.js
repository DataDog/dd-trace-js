const sum = require('./sum-coverage-test.js')

describe('jest-itr-pass', () => {
  it('will be run', () => {
    expect(sum(1, 2)).toEqual(3)
  })
})
