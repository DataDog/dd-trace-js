'use strict'

describe('concurrent attempt to fix each tests', () => {
  const parameterizedTest = test.concurrent.each([
    ['parameterized row', 3],
  ])
  parameterizedTest('%s can pass normally', (_label, expected) => {
    expect(expected).toBe(3)
  })
})
