import { expect, test } from 'vitest'
import { noAutoRetry, preventFailureSuppression } from 'dd-trace/test-optimization.js'

import { tracked } from './browser-exclusions-ledger.mjs'

function fail () { throw new Error('protected browser failure') }
const each = test.each([1, 2])
each('combined %s', preventFailureSuppression(noAutoRetry(tracked('combined', fail))))
test('quarantined exclusion', noAutoRetry(tracked('quarantined exclusion', fail)))
test('disabled exclusion', noAutoRetry(tracked('disabled exclusion', fail)))
test('protected retries', preventFailureSuppression(tracked('protected retries', fail)))
test('protected passing', preventFailureSuppression(noAutoRetry(tracked('protected passing', () => {}))))
let executions = 0
test('native retry', { retry: 2 }, noAutoRetry(tracked('native retry', () => {
  expect(++executions).toBeGreaterThan(1)
})))
test.skip('developer skip', preventFailureSuppression(noAutoRetry(tracked('developer skip', fail))))
test('ordinary control', tracked('ordinary control', fail))
