'use strict'

const { test } = require('@playwright/test')

test.describe.configure({ mode: 'serial' })
if (process.env.PLAYWRIGHT_SUITE_RETRIES) test.describe.configure({ retries: 0 })

test('exports completed test', () => {})

test('waits for the completed trace', async () => {
  await fetch(process.env.TRACE_RECEIVED_URL)
})
