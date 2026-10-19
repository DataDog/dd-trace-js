'use strict'

const { test, expect } = require('@playwright/test')
const { preventFailureSuppression, noAutoRetry } = require('dd-trace/test-optimization')

async function failure ({ baseURL }, testInfo) {
  expect({ title: testInfo.title, baseURL }).toEqual({ title: 'this intentionally fails' })
}
for (const row of ['one', 'two']) {
  test(`combined ${row}`, preventFailureSuppression(noAutoRetry(failure)))
}
test('quarantined exclusion', noAutoRetry(failure))
test('disabled exclusion', noAutoRetry(failure))
test('protected retries', preventFailureSuppression(failure))
test('protected attempt to fix', preventFailureSuppression(failure))
test('protected passing', preventFailureSuppression(noAutoRetry(async ({ baseURL }, testInfo) => {
  expect(baseURL).toBeUndefined()
  expect(testInfo.title).toBe('protected passing')
})))
test('ordinary control', failure)
// Developer skips retain annotations without executing the callback.
test.skip('developer skip', preventFailureSuppression(noAutoRetry(failure)))
