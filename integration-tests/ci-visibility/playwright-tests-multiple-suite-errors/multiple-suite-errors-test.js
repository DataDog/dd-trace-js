'use strict'

const { test } = require('@playwright/test')

test('first failing test', () => {
  throw new Error('first failure')
})

test('second failing test', () => {
  // Playwright serializes non-Error rejections through value instead of message.
  // eslint-disable-next-line prefer-promise-reject-errors
  return Promise.reject('second failure')
})
