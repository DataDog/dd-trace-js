'use strict'

const { test, expect } = require('@playwright/test')

test.describe('efd repeat each', () => {
  test('native repeat test', async () => {
    expect(1 + 1).toBe(2)
  })
})
