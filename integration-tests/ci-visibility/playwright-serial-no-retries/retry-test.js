'use strict'

const { test, expect } = require('@playwright/test')

test.describe.configure({ mode: 'serial' })
if (process.env.PLAYWRIGHT_SUITE_RETRIES) test.describe.configure({ retries: 0 })

test('exports completed test', () => {})

test('waits for the completed trace', async () => {
  await expect.poll(async () => {
    const response = await fetch(process.env.TRACE_RECEIVED_URL)
    return (await response.json()).traceReceived
  }, { timeout: test.info().timeout }).toBe(true)
})
