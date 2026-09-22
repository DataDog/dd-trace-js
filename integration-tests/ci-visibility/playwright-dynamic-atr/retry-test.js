'use strict'

const { test, expect } = require('@playwright/test')

if (process.env.PLAYWRIGHT_SUITE_RETRIES !== undefined) {
  test.describe.configure({ retries: Number(process.env.PLAYWRIGHT_SUITE_RETRIES) })
}

if (process.env.PLAYWRIGHT_SERIAL_RETRY) {
  test.describe.configure({ mode: 'serial' })
  test('earlier serial test', () => {
    expect(test.info().retry).toBeGreaterThan(0)
  })
}

test('always fails', async () => {
  if (process.env.PLAYWRIGHT_EXPECTED_FAILURE) {
    test.fail()
    if (process.env.PLAYWRIGHT_EXPECTED_FAILURE === 'passes') return
    if (process.env.PLAYWRIGHT_EXPECTED_FAILURE === 'times-out') {
      test.setTimeout(100)
      await new Promise(() => {})
    }
  }
  if (process.env.PLAYWRIGHT_SLOW_INITIAL_ATTEMPT && test.info().retry === 0) {
    await new Promise(resolve => setTimeout(resolve, 6000))
  }
  expect(true).toBe(false)
})
