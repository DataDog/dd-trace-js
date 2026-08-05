'use strict'

const { describe, expect, test } = require('@jest/globals')

describe('concurrent imported attempt to fix tests', () => {
  test.concurrent('can pass normally', () => {
    expect(1 + 2).toBe(3)
  })
})
