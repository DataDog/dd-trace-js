'use strict'

const { test } = require('@playwright/test')

test('submits a global console error', () => {
  // eslint-disable-next-line no-console
  console.error('Playwright console error: %d', 42)
})
