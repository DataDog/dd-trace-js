'use strict'

const { test } = require('@playwright/test')

test.describe('unimpacted test', () => {
  test('should not be impacted', () => {})
})
