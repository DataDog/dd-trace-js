'use strict'

const { test } = require('@playwright/test')

if (process.env.PLAYWRIGHT_GLOBAL_ERROR_MODE === 'collection') {
  throw new Error('Synthetic collection failure 1')
}

test('synthetic test', () => {})
