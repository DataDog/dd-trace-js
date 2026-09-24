'use strict'

const { describe, expect, test } = require('@jest/globals')

describe('early flake detection concurrent tests', () => {
  const parameterizedTest = test.concurrent.only.each([
    ['can pass normally'],
  ])
  parameterizedTest('%s', () => {
    expect(1 + 2).toBe(3)
  })
})
