'use strict'

const { test } = require('@playwright/test')

test('always fails', () => {
  throw new Error('expected failure')
})
