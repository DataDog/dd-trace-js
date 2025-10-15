'use strict'

describe('jest-bad-import-test-2', () => {
  afterAll(() => {
    setImmediate(() => {
      require('./off-timing-import')
    })
  })
  it('can report tests', () => {
    expect(1 + 2).toEqual(3)
  })
})
