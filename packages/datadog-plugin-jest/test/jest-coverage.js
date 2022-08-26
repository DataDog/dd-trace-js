const sum = require('./sum-coverage-test.js')

describe('jest-coverage', () => {
  it('can sum', () => {
    expect(sum(1, 2)).toEqual(3)
  })
})
