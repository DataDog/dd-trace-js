'use strict'

const { test } = require('@playwright/test')

test('should be disabled', () => {
  throw new Error('disabled test should not execute')
})
