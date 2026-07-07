'use strict'

const { describe, expect, test } = require('@jest/globals')

describe('early flake detection concurrent tests', () => {
  test.concurrent.only.each([
    ['can pass normally'],
  ])('%s', () => {
    expect(1 + 2).toBe(3)
  })
})
