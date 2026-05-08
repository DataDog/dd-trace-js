'use strict'

const { test, expect } = require('@playwright/test')

test.describe('efd repeat duration', () => {
  test('repeat-scoped test', async () => {
    if (test.info().repeatEachIndex === 0) {
      await new Promise(resolve => setTimeout(resolve, 6_000))
    }

    expect(1 + 1).toBe(2)
  })
})
