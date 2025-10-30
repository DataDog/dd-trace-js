'use strict'

const { test, expect } = require('@playwright/test')

test.describe('long suite', () => {
  test('should be able to run', async () => {
    await new Promise(resolve => setTimeout(resolve, 5000))
    expect(true).toBe(true)
  })
})
