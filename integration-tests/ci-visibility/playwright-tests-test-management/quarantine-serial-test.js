'use strict'

const { test, expect } = require('@playwright/test')

test.describe.serial('quarantine serial', () => {
  test('first fails and is quarantined', async () => {
    expect(true).toBe(false)
  })

  test('second did not run', async () => {
    expect(true).toBe(true)
  })

  test('third did not run', async () => {
    expect(true).toBe(true)
  })
})
