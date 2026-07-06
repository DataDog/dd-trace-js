'use strict'

describe('early flake detection concurrent tests', () => {
  test.concurrent('can pass normally', () => {
    expect(1 + 2).toBe(3)
  })
})
