'use strict'

describe('concurrent attempt to fix each tests', () => {
  test.concurrent.each([
    ['parameterized row', 3],
  ])('%s can pass normally', (_label, expected) => {
    expect(expected).toBe(3)
  })
})
