'use strict'

const { test, expect } = require('@playwright/test')

test.describe('failing test', () => {
  test('fails and causes early bail', async () => {
    expect(true).toBe(false)
  })
})
