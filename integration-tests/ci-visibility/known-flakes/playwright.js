'use strict'

const { test } = require('@playwright/test')

test('known flaky failure', () => { throw new Error('known failure') })
test('new failure', () => { throw new Error('new failure') })
// Playwright requires fixture destructuring, even when the test needs no fixtures.
// eslint-disable-next-line no-empty-pattern
test('recovers', ({}, testInfo) => {
  if (testInfo.retry === 0) throw new Error('intermittent failure')
})
