'use strict'

const { test, expect } = require('@playwright/test')

test.describe('efd duration retries', () => {
  test('instant test', async () => {
    expect(1 + 1).toBe(2)
  })

  test('slightly slow test', async () => {
    await new Promise(resolve => setTimeout(resolve, 11_000))
    expect(1 + 1).toBe(2)
  })
})
