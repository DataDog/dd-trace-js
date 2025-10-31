'use strict'

const { test, expect } = require('@playwright/test')

test.describe('did not run', () => {
  test('because of early bail', async () => {
    expect(true).toBe(false)
  })
})
