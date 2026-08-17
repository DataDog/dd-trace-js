'use strict'

const { test } = require('@playwright/test')

test('first failing test', () => {
  throw new Error('first failure')
})

test('second failing test', () => {
  throw new Error('second failure')
})
